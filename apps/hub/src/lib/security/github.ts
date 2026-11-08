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

/**
 * Dependabot (and org advisories) for an org; for a personal account the org
 * endpoints 404, so walk the user's repos instead. Repos with Dependabot off are skipped.
 */
export async function syncGitHubAccount(
  opts: FetchOpts & { name: string },
): Promise<{ findings: NormalizedFinding[]; warnings: string[] }> {
  const name = normalizeScmPath("github", opts.name);
  const warnings: string[] = [];
  try {
    const alerts = await fetchGitHubDependabotAlerts({ ...opts, org: name });
    const findings = parseGitHubDependabotAlerts(alerts, name);
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
        `/repos/${repo.split("/").map(encodeURIComponent).join("/")}/dependabot/alerts?state=open&per_page=100`,
        `github dependabot ${repo}`,
      );
      for (const f of parseGitHubDependabotAlerts(alerts, repo)) {
        if (!f.resource.startsWith(`${repo}/`)) f.resource = `${repo}/${f.resource}`;
        findings.push(f);
      }
    } catch (err) {
      const off =
        err instanceof ScmHttpError &&
        (err.status === 404 || (err.status === 403 && /disabled/i.test(err.message)));
      if (!off) warnings.push(err instanceof Error ? err.message : `github dependabot ${repo} failed`);
    }
  }
  return { findings, warnings };
}
