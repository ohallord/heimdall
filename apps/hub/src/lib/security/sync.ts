import {
  fetchGitHubDependabotAlerts,
  fetchGitHubOrgAdvisories,
  parseGitHubDependabotAlerts,
  parseGitHubOrgAdvisories,
} from "./github";
import {
  fetchGitLabVulnerabilities,
  parseGitLabVulnerabilities,
} from "./gitlab";
import { parseOsvScannerReport } from "./osv";
import { listSecurityConnections, upsertFindings } from "./store";
import { parseTrivyReport } from "./trivy";
import type { NormalizedFinding } from "./types";

export type ScanKind = "image" | "host_posture";

export type ScanIngestInput = {
  orgId: string;
  trivyReport?: unknown;
  osvReport?: unknown;
  syncRemotes?: boolean;
  /** When host_posture, Trivy findings are tagged host_posture + agentId. */
  scanKind?: ScanKind;
  agentId?: string;
};

export type ScanIngestResult = {
  written: number;
  bySource: Record<string, number>;
  errors: string[];
};

function countBySource(findings: NormalizedFinding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) {
    out[f.source] = (out[f.source] ?? 0) + 1;
  }
  return out;
}

export async function ingestSecurityScan(
  input: ScanIngestInput,
): Promise<ScanIngestResult> {
  const collected: NormalizedFinding[] = [];
  const errors: string[] = [];
  const scanKind = input.scanKind ?? "image";
  const agentId = input.agentId?.trim() || undefined;

  if (input.trivyReport != null) {
    if (scanKind === "host_posture") {
      collected.push(
        ...parseTrivyReport(input.trivyReport, {
          source: "host_posture",
          fallbackResource: "host-rootfs",
          agentId,
        }),
      );
    } else {
      collected.push(
        ...parseTrivyReport(input.trivyReport, {
          source: "trivy",
          agentId,
        }),
      );
    }
  }
  if (input.osvReport != null) {
    collected.push(...parseOsvScannerReport(input.osvReport));
  }

  if (input.syncRemotes) {
    const connections = await listSecurityConnections(input.orgId);
    for (const conn of connections) {
      if (!conn.enabled) continue;
      const config = JSON.parse(conn.config_json) as Record<string, unknown>;
      const token = typeof config.token === "string" ? config.token : "";
      if (!token) {
        errors.push(`${conn.kind}:${conn.name} missing token`);
        continue;
      }
      try {
        if (conn.kind === "github") {
          const org =
            (typeof config.org === "string" && config.org) || conn.name;
          const apiBaseUrl =
            typeof config.apiBaseUrl === "string"
              ? config.apiBaseUrl
              : undefined;
          const dependabot = await fetchGitHubDependabotAlerts({
            token,
            org,
            apiBaseUrl,
          });
          collected.push(...parseGitHubDependabotAlerts(dependabot, org));
          try {
            const advisories = await fetchGitHubOrgAdvisories({
              token,
              org,
              apiBaseUrl,
            });
            collected.push(...parseGitHubOrgAdvisories(advisories, org));
          } catch (err) {
            // Org advisories may require extra permissions; Dependabot still counts.
            errors.push(
              `github advisories ${org}: ${err instanceof Error ? err.message : "failed"}`,
            );
          }
        } else if (conn.kind === "gitlab") {
          const projectPath =
            (typeof config.projectPath === "string" && config.projectPath) ||
            conn.name;
          const apiBaseUrl =
            typeof config.apiBaseUrl === "string"
              ? config.apiBaseUrl
              : undefined;
          const payload = await fetchGitLabVulnerabilities({
            token,
            projectPath,
            apiBaseUrl,
          });
          collected.push(
            ...parseGitLabVulnerabilities(payload, projectPath),
          );
        }
      } catch (err) {
        errors.push(
          `${conn.kind}:${conn.name}: ${err instanceof Error ? err.message : "sync failed"}`,
        );
      }
    }
  }

  const written = await upsertFindings(input.orgId, collected);
  return { written, bySource: countBySource(collected), errors };
}
