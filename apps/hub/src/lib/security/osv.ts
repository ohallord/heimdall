import { normalizeSeverity, type NormalizedFinding } from "./types";

type OsvVuln = {
  id?: string;
  summary?: string;
  details?: string;
  database_specific?: { severity?: string };
  severity?: Array<{ type?: string; score?: string }>;
  aliases?: string[];
  references?: Array<{ type?: string; url?: string }>;
};

type OsvScannerPackage = {
  package?: { name?: string; version?: string; ecosystem?: string };
  vulnerabilities?: OsvVuln[];
  groups?: Array<{ ids?: string[]; max_severity?: string }>;
};

type OsvScannerResult = {
  source?: { path?: string; type?: string };
  packages?: OsvScannerPackage[];
};

type OsvScannerReport = {
  results?: OsvScannerResult[];
};

function severityFromOsv(v: OsvVuln, groupMax?: string): string {
  if (groupMax) return groupMax;
  if (v.database_specific?.severity) return v.database_specific.severity;
  const score = v.severity?.[0]?.score;
  if (score) {
    const n = Number(score);
    if (Number.isFinite(n)) {
      if (n >= 9) return "critical";
      if (n >= 7) return "high";
      if (n >= 4) return "medium";
      if (n > 0) return "low";
    }
  }
  return "unknown";
}

/** Parse osv-scanner JSON output (or OSV batch-shaped results). */
export function parseOsvScannerReport(
  input: unknown,
): NormalizedFinding[] {
  const report = (input ?? {}) as OsvScannerReport;
  const findings: NormalizedFinding[] = [];

  for (const result of report.results ?? []) {
    const resource = result.source?.path?.trim() || "lockfile";
    for (const pkg of result.packages ?? []) {
      const name = pkg.package?.name;
      const version = pkg.package?.version;
      const groupMax = pkg.groups?.[0]?.max_severity;
      for (const v of pkg.vulnerabilities ?? []) {
        const externalId = (v.id || "").trim();
        if (!externalId) continue;
        const cve = (v.aliases ?? []).find((a) => a.startsWith("CVE-"));
        const url =
          v.references?.find((r) => r.type === "ADVISORY")?.url ??
          v.references?.[0]?.url;
        findings.push({
          source: "osv",
          externalId,
          title: (v.summary || v.details || externalId).trim(),
          severity: normalizeSeverity(severityFromOsv(v, groupMax)),
          packageName: name,
          packageVersion: version,
          resource,
          cve,
          url,
          raw: v,
        });
      }
    }
  }
  return findings;
}

/** Parse a single OSV API vulnerability object (query/vulns response item). */
export function parseOsvApiVuln(
  vuln: unknown,
  pkg: { name: string; version: string; ecosystem?: string; path?: string },
): NormalizedFinding | null {
  const v = (vuln ?? {}) as OsvVuln;
  const externalId = (v.id || "").trim();
  if (!externalId) return null;
  return {
    source: "osv",
    externalId,
    title: (v.summary || v.details || externalId).trim(),
    severity: normalizeSeverity(severityFromOsv(v)),
    packageName: pkg.name,
    packageVersion: pkg.version,
    resource: pkg.path || `${pkg.ecosystem ?? "pkg"}:${pkg.name}`,
    cve: (v.aliases ?? []).find((a) => a.startsWith("CVE-")),
    url: v.references?.[0]?.url,
    raw: v,
  };
}
