import { normalizeSeverity, type NormalizedFinding } from "./types";
import { normalizeScmPath, ScmHttpError } from "./scm-path";
import { guardedFetch } from "@/lib/http-guard/safe-fetch";

type DependabotAlert = {
  number?: number;
  state?: string;
  html_url?: string;
  dependency?: {
    package?: { name?: string; ecosystem?: string };
    manifest_path?: string;
  };
  security_advisory?: {
    ghsa_id?: string;
    cve_id?: string | null;
    summary?: string;
    severity?: string;
    description?: string;
  };
  security_vulnerability?: {
    vulnerable_version_range?: string;
    first_patched_version?: { identifier?: string } | null;
  };
};

type CodeScanningAlert = {
  number?: number;
  state?: string;
  html_url?: string;
  rule?: {
    id?: string;
    description?: string;
    severity?: string;
    security_severity_level?: string;
  };
  most_recent_instance?: {
    commit_sha?: string;
    location?: { path?: string; start_line?: number };
    message?: { text?: string };
  };
  repository?: { full_name?: string };
};

type OrgAdvisory = {
  ghsa_id?: string;
  cve_id?: string | null;
  summary?: string;
  description?: string;
  severity?: string;
  html_url?: string;
  vulnerabilities?: Array<{
    package?: { name?: string; ecosystem?: string };
    vulnerable_version_range?: string;
    first_patched_version?: string | null;
  }>;
};

export function parseGitHubDependabotAlerts(
  input: unknown,
  orgFallback = "github",
): NormalizedFinding[] {
  const alerts = Array.isArray(input) ? (input as DependabotAlert[]) : [];
  const findings: NormalizedFinding[] = [];
  for (const a of alerts) {
    if (a.state && a.state !== "open") continue;
    const ghsa = a.security_advisory?.ghsa_id || "";
    const externalId = ghsa || (a.number != null ? `dependabot-${a.number}` : "");
    if (!externalId) continue;
    const pkg = a.dependency?.package?.name;
    const resource =
      a.dependency?.manifest_path ||
      `${orgFallback}/${pkg || "dependency"}`;
    findings.push({
      source: "github",
      externalId,
      title: (a.security_advisory?.summary || externalId).trim(),
      severity: normalizeSeverity(a.security_advisory?.severity),
      packageName: pkg,
      packageVersion: a.security_vulnerability?.vulnerable_version_range,
      fixedVersion:
        a.security_vulnerability?.first_patched_version?.identifier ||
        undefined,
      resource,
      cve: a.security_advisory?.cve_id || undefined,
      url: a.html_url,
      raw: a,
    });
  }
  return findings;
}

function codeScanningSeverity(alert: CodeScanningAlert): ReturnType<typeof normalizeSeverity> {
  const level = normalizeSeverity(alert.rule?.security_severity_level);
  if (level !== "unknown") return level;
  const bucket = (alert.rule?.severity || "").toLowerCase();
  if (bucket === "error") return "high";
  if (bucket === "warning") return "medium";
  if (bucket === "note") return "low";
  return "unknown";
}

/** Blob URL for a code-scanning finding. Uses the scanned commit when we have it, otherwise HEAD. */
export function githubCodeLineUrl(input: {
  source: string;
  resource?: string | null;
  raw?: unknown;
}): string | null {
  if (input.source !== "github" || !input.raw || typeof input.raw !== "object") return null;
  const raw = input.raw as { path?: unknown; line?: unknown; commit?: unknown };
  const path = typeof raw.path === "string" ? raw.path.replace(/^\/+/, "") : "";
  const line = typeof raw.line === "number" ? raw.line : Number.NaN;
  if (!path || path.includes("..") || !Number.isInteger(line) || line < 1) return null;
  const resource = input.resource ?? "";
  const suffix = `/${path}:${line}`;
  if (!resource.endsWith(suffix)) return null;
  const repo = resource.slice(0, -suffix.length);
  if (!/^[^/]+\/[^/]+$/.test(repo)) return null;
  const commit = typeof raw.commit === "string" && /^[0-9a-f]{7,40}$/i.test(raw.commit) ? raw.commit : "HEAD";
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repo}/blob/${commit}/${encoded}#L${line}`;
}

export function githubCodeLineUrlFromJson(input: {
  source: string;
  resource?: string | null;
  rawJson?: string | null;
}): string | null {
  let raw: unknown = null;
  try {
    raw = JSON.parse(input.rawJson || "null");
  } catch {
    return null;
  }
  return githubCodeLineUrl({ source: input.source, resource: input.resource, raw });
}

/** Open CodeQL / code-scanning alerts. Alert numbers are per repo, so the resource keeps the repo. */
export function parseGitHubCodeScanningAlerts(
  input: unknown,
  repoFallback = "github",
): NormalizedFinding[] {
  const alerts = Array.isArray(input) ? (input as CodeScanningAlert[]) : [];
  const findings: NormalizedFinding[] = [];
  for (const a of alerts) {
    if (a.state && a.state !== "open") continue;
    if (a.number == null) continue;
    const repo = (a.repository?.full_name || repoFallback).replace(/\/$/, "");
    const path = a.most_recent_instance?.location?.path || "code-scanning";
    const line = a.most_recent_instance?.location?.start_line;
    const commit = a.most_recent_instance?.commit_sha;
    const where = line != null ? `${path}:${line}` : path;
    const description = (a.rule?.description || a.most_recent_instance?.message?.text || a.rule?.id || "").trim();
    findings.push({
      source: "github",
      externalId: `code-scanning-${a.number}`,
      title: description || `code-scanning-${a.number}`,
      severity: codeScanningSeverity(a),
      resource: `${repo}/${where}`,
      url: a.html_url,
      raw: {
        number: a.number,
        rule: a.rule?.id,
        severity: a.rule?.security_severity_level || a.rule?.severity,
        path,
        line,
        commit,
        message: a.most_recent_instance?.message?.text,
      },
    });
  }
  return findings;
}

export function parseGitHubOrgAdvisories(
  input: unknown,
  orgFallback = "github",
): NormalizedFinding[] {
  const advisories = Array.isArray(input) ? (input as OrgAdvisory[]) : [];
  const findings: NormalizedFinding[] = [];
  for (const a of advisories) {
    const externalId = (a.ghsa_id || "").trim();
    if (!externalId) continue;
    const first = a.vulnerabilities?.[0];
    findings.push({
      source: "github",
      externalId,
      title: (a.summary || externalId).trim(),
      severity: normalizeSeverity(a.severity),
      packageName: first?.package?.name,
      packageVersion: first?.vulnerable_version_range,
      fixedVersion: first?.first_patched_version || undefined,
      resource: `${orgFallback}/advisory/${externalId}`,
      cve: a.cve_id || undefined,
      url: a.html_url,
      raw: a,
    });
  }
  return findings;
}

export async function fetchGitHubDependabotAlerts(input: {
  token: string;
  org: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<unknown> {
  const base = (input.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const fetchFn = input.fetchImpl ?? guardedFetch;
  const res = await fetchFn(
    `${base}/orgs/${encodeURIComponent(normalizeScmPath("github", input.org))}/dependabot/alerts?state=open&per_page=100`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "heimdall-hub",
      },
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ScmHttpError(`github dependabot ${res.status}: ${text.slice(0, 200)}`, res.status);
  }
  return res.json();
}

export async function fetchGitHubOrgAdvisories(input: {
  token: string;
  org: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<unknown> {
  const base = (input.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const fetchFn = input.fetchImpl ?? guardedFetch;
  const res = await fetchFn(
    `${base}/orgs/${encodeURIComponent(normalizeScmPath("github", input.org))}/security-advisories?per_page=100`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "heimdall-hub",
      },
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ScmHttpError(`github advisories ${res.status}: ${text.slice(0, 200)}`, res.status);
  }
  return res.json();
}

type FetchOpts = { token: string; apiBaseUrl?: string; fetchImpl?: typeof fetch };

async function githubGet(opts: FetchOpts, path: string, label: string): Promise<unknown> {
  const base = (opts.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const fetchFn = opts.fetchImpl ?? guardedFetch;
  const res = await fetchFn(`${base}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${opts.token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "heimdall-hub",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ScmHttpError(`${label} ${res.status}: ${text.slice(0, 200)}`, res.status);
  }
  return res.json();
}

function featureOff(err: unknown): boolean {
  return (
    err instanceof ScmHttpError &&
    (err.status === 404 || (err.status === 403 && /disabled|not enabled/i.test(err.message)))
  );
}

type RepoRow = { full_name?: string; owner?: { login?: string }; archived?: boolean };

/** Non-archived repos owned by `owner` (first 100). Private ones when the token is that user's. */
export async function fetchGitHubOwnerRepos(opts: FetchOpts & { owner: string }): Promise<string[]> {
  const pick = (rows: unknown) =>
    (Array.isArray(rows) ? (rows as RepoRow[]) : [])
      .filter((r) => !r.archived && r.full_name)
      .filter((r) => (r.owner?.login ?? "").toLowerCase() === opts.owner.toLowerCase())
      .map((r) => r.full_name!);
  const mine = pick(
    await githubGet(opts, "/user/repos?affiliation=owner&per_page=100", "github repos"),
  );
  if (mine.length) return mine;
  return pick(
    await githubGet(
      opts,
      `/users/${encodeURIComponent(opts.owner)}/repos?type=owner&per_page=100`,
      "github repos",
    ),
  );
}

function repoApiPath(repo: string, rest: string): string {
  return `/repos/${repo.split("/").map(encodeURIComponent).join("/")}${rest}`;
}

async function codeScanningFindings(
  opts: FetchOpts,
  path: string,
  label: string,
  repoFallback: string,
): Promise<{ findings: NormalizedFinding[]; warning?: string }> {
  try {
    const alerts = await githubGet(opts, path, label);
    return { findings: parseGitHubCodeScanningAlerts(alerts, repoFallback) };
  } catch (err) {
    if (featureOff(err)) return { findings: [] };
    return { findings: [], warning: err instanceof Error ? err.message : `${label} failed` };
  }
}

/**
 * Dependabot, code scanning, and org advisories. A personal account 404s the
 * org endpoints, so walk that user's repos instead. Repos with Dependabot or
 * code scanning turned off are skipped.
 */
export async function syncGitHubAccount(
  opts: FetchOpts & { name: string },
): Promise<{ findings: NormalizedFinding[]; warnings: string[] }> {
  const name = normalizeScmPath("github", opts.name);
  const warnings: string[] = [];
  try {
    const alerts = await fetchGitHubDependabotAlerts({ ...opts, org: name });
    const findings = parseGitHubDependabotAlerts(alerts, name);
    const scanning = await codeScanningFindings(
      opts,
      `/orgs/${encodeURIComponent(name)}/code-scanning/alerts?state=open&per_page=100`,
      `github code scanning ${name}`,
      name,
    );
    findings.push(...scanning.findings);
    if (scanning.warning) warnings.push(scanning.warning);
    try {
      findings.push(...parseGitHubOrgAdvisories(await fetchGitHubOrgAdvisories({ ...opts, org: name }), name));
    } catch (err) {
      // Org advisories may require extra permissions; Dependabot still counts.
      warnings.push(`github advisories ${name}: ${err instanceof Error ? err.message : "failed"}`);
    }
    return { findings, warnings };
  } catch (err) {
    if (!(err instanceof ScmHttpError && err.status === 404)) throw err;
  }

  const findings: NormalizedFinding[] = [];
  for (const repo of await fetchGitHubOwnerRepos({ ...opts, owner: name })) {
    try {
      const alerts = await githubGet(
        opts,
        repoApiPath(repo, "/dependabot/alerts?state=open&per_page=100"),
        `github dependabot ${repo}`,
      );
      for (const f of parseGitHubDependabotAlerts(alerts, repo)) {
        if (!f.resource.startsWith(`${repo}/`)) f.resource = `${repo}/${f.resource}`;
        findings.push(f);
      }
    } catch (err) {
      if (!featureOff(err)) warnings.push(err instanceof Error ? err.message : `github dependabot ${repo} failed`);
    }
    const scanning = await codeScanningFindings(
      opts,
      repoApiPath(repo, "/code-scanning/alerts?state=open&per_page=100"),
      `github code scanning ${repo}`,
      repo,
    );
    findings.push(...scanning.findings);
    if (scanning.warning) warnings.push(scanning.warning);
  }
  return { findings, warnings };
}
