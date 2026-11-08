import type { VulnSource } from "@/lib/db/types";

export type VulnSeverity =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "unknown";

/** Normalized finding used by all Phase 6 parsers before persistence. */
export type NormalizedFinding = {
  source: VulnSource;
  externalId: string;
  title: string;
  severity: VulnSeverity;
  packageName?: string;
  packageVersion?: string;
  fixedVersion?: string;
  resource: string;
  cve?: string;
  url?: string;
  agentId?: string;
  raw: unknown;
};

export function normalizeSeverity(raw: unknown): VulnSeverity {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (s === "critical" || s === "crit") return "critical";
  if (s === "high" || s === "important") return "high";
  if (s === "medium" || s === "moderate" || s === "med") return "medium";
  if (s === "low" || s === "minor") return "low";
  if (s === "info" || s === "negligible" || s === "unknown" || s === "") {
    return "unknown";
  }
  return "unknown";
}
