import { syncGitHubAccount } from "./github";
import { syncGitLabPath } from "./gitlab";
import { parseOsvScannerReport } from "./osv";
import { listSecurityConnections, resolveUnseenFindings, upsertFindings } from "./store";
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
  // Remote kinds whose every enabled connection synced cleanly; only those are reconciled.
  const cleanKinds = new Set<"github" | "gitlab">();
  const dirtyKinds = new Set<string>();
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
      const before = errors.length;
      const config = JSON.parse(conn.config_json) as Record<string, unknown>;
      const token = typeof config.token === "string" ? config.token : "";
      if (!token) {
        errors.push(`${conn.kind}:${conn.name} missing token`);
        dirtyKinds.add(conn.kind);
        continue;
      }
      try {
        const apiBaseUrl =
          typeof config.apiBaseUrl === "string" ? config.apiBaseUrl : undefined;
        if (conn.kind === "github") {
          const name = (typeof config.org === "string" && config.org) || conn.name;
          const r = await syncGitHubAccount({ token, name, apiBaseUrl });
          collected.push(...r.findings);
          errors.push(...r.warnings.map((w) => `${conn.kind}:${conn.name}: ${w}`));
        } else if (conn.kind === "gitlab") {
          const path =
            (typeof config.projectPath === "string" && config.projectPath) || conn.name;
          const r = await syncGitLabPath({ token, path, apiBaseUrl });
          collected.push(...r.findings);
          errors.push(...r.warnings.map((w) => `${conn.kind}:${conn.name}: ${w}`));
        }
      } catch (err) {
        errors.push(
          `${conn.kind}:${conn.name}: ${err instanceof Error ? err.message : "sync failed"}`,
        );
      }
      if (errors.length > before) dirtyKinds.add(conn.kind);
      else if (conn.kind === "github" || conn.kind === "gitlab") cleanKinds.add(conn.kind);
    }
  }

  for (const e of errors) console.warn(`[security-sync] org=${input.orgId} ${e}`);
  const written = await upsertFindings(input.orgId, collected);
  for (const kind of cleanKinds) {
    if (dirtyKinds.has(kind)) continue;
    await resolveUnseenFindings(input.orgId, kind, collected);
  }
  return { written, bySource: countBySource(collected), errors };
}
