import { normalizeSeverity, type NormalizedFinding } from "./types";
import { normalizeScmPath } from "./scm-path";
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
      },
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`github dependabot ${res.status}: ${text.slice(0, 200)}`);
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
      },
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`github advisories ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}
