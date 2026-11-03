import { normalizeSeverity, type NormalizedFinding } from "./types";
import type { VulnSource } from "@/lib/db/types";

type TrivyVulnerability = {
  VulnerabilityID?: string;
  PkgName?: string;
  InstalledVersion?: string;
  FixedVersion?: string;
  Severity?: string;
  Title?: string;
  Description?: string;
  PrimaryURL?: string;
};

type TrivyMisconfiguration = {
  ID?: string;
  AVDID?: string;
  CheckID?: string;
  Title?: string;
  Message?: string;
  Description?: string;
  Severity?: string;
  PrimaryURL?: string;
  Resolution?: string;
};

type TrivyResult = {
  Target?: string;
  Type?: string;
  Vulnerabilities?: TrivyVulnerability[] | null;
  Misconfigurations?: TrivyMisconfiguration[] | null;
};

type TrivyReport = {
  Results?: TrivyResult[];
};

export type ParseTrivyOptions = {
  source?: VulnSource;
  fallbackResource?: string;
  agentId?: string;
};

/** Parse Trivy `--format json` image/fs/rootfs report into normalized findings. */
export function parseTrivyReport(
  input: unknown,
  fallbackResourceOrOpts: string | ParseTrivyOptions = "unknown-image",
): NormalizedFinding[] {
  const opts: ParseTrivyOptions =
    typeof fallbackResourceOrOpts === "string"
      ? { fallbackResource: fallbackResourceOrOpts }
      : fallbackResourceOrOpts;
  const source = opts.source ?? "trivy";
  const fallbackResource = opts.fallbackResource ?? "unknown-image";
  const agentId = opts.agentId?.trim() || undefined;

  const report = (input ?? {}) as TrivyReport;
  const findings: NormalizedFinding[] = [];
  for (const result of report.Results ?? []) {
    const resource = result.Target?.trim() || fallbackResource;
    for (const v of result.Vulnerabilities ?? []) {
      const externalId = (v.VulnerabilityID || "").trim();
      if (!externalId) continue;
      findings.push({
        source,
        externalId,
        title: (v.Title || v.Description || externalId).trim(),
        severity: normalizeSeverity(v.Severity),
        packageName: v.PkgName,
        packageVersion: v.InstalledVersion,
        fixedVersion: v.FixedVersion || undefined,
        resource,
        cve: externalId.startsWith("CVE-") ? externalId : undefined,
        url: v.PrimaryURL,
        agentId,
        raw: v,
      });
    }
    for (const m of result.Misconfigurations ?? []) {
      const externalId = (
        m.ID ||
        m.AVDID ||
        m.CheckID ||
        ""
      ).trim();
      if (!externalId) continue;
      findings.push({
        source,
        externalId,
        title: (m.Title || m.Message || m.Description || externalId).trim(),
        severity: normalizeSeverity(m.Severity),
        resource,
        url: m.PrimaryURL || undefined,
        agentId,
        raw: m,
      });
    }
  }
  return findings;
}
