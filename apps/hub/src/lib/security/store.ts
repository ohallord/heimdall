import { safeHttpUrl } from "./safe-url";
import { getDb } from "@/lib/db/client";
import type {
  SecurityConnectionKind,
  SecurityConnectionRow,
  VulnFindingRow,
  VulnSource,
} from "@/lib/db/types";
import { newId } from "@/lib/ids";
import { openConnection, sealJson } from "@/lib/db/secrets";
import { maybeRaiseFindingAlarm } from "./findings-alarms";
import type { NormalizedFinding } from "./types";

export async function upsertSecurityConnection(input: {
  orgId: string;
  kind: SecurityConnectionKind;
  name: string;
  config: Record<string, unknown>;
  tokenHint?: string;
  enabled?: boolean;
}): Promise<SecurityConnectionRow> {
  const db = await getDb();
  const existing = await db.query<SecurityConnectionRow>(
    `SELECT * FROM security_connections
     WHERE org_id = $1 AND kind = $2 AND name = $3 LIMIT 1`,
    [input.orgId, input.kind, input.name],
  );
  const configJson = sealJson(JSON.stringify(input.config));
  const enabled = input.enabled ?? true;
  const hint = input.tokenHint ?? null;

  if (existing.rows[0]) {
    await db.query(
      `UPDATE security_connections
       SET config_json = $1, token_hint = COALESCE($2, token_hint), enabled = $3, updated_at = NOW()
       WHERE id = $4`,
      [configJson, hint, enabled, existing.rows[0].id],
    );
    return openConnection(
      (
        await db.query<SecurityConnectionRow>(
          `SELECT * FROM security_connections WHERE id = $1`,
          [existing.rows[0].id],
        )
      ).rows[0],
    );
  }

  const id = newId("sec");
  await db.query(
    `INSERT INTO security_connections
      (id, org_id, kind, name, config_json, token_hint, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, input.orgId, input.kind, input.name, configJson, hint, enabled],
  );
  return openConnection(
    (
      await db.query<SecurityConnectionRow>(
        `SELECT * FROM security_connections WHERE id = $1`,
        [id],
      )
    ).rows[0],
  );
}

export async function listSecurityConnections(
  orgId: string,
): Promise<SecurityConnectionRow[]> {
  const db = await getDb();
  const result = await db.query<SecurityConnectionRow>(
    `SELECT * FROM security_connections WHERE org_id = $1 ORDER BY kind, name`,
    [orgId],
  );
  return result.rows.map(openConnection);
}

export async function findFindingByNaturalKey(
  orgId: string,
  input: {
    source: VulnSource;
    externalId: string;
    resource: string;
    agentId?: string | null;
  },
): Promise<VulnFindingRow | null> {
  const db = await getDb();
  const agentKey = input.agentId?.trim() || "";
  const result = await db.query<VulnFindingRow>(
    `SELECT * FROM vuln_findings
     WHERE org_id = $1 AND source = $2 AND external_id = $3
       AND resource = $4 AND agent_key = $5
     LIMIT 1`,
    [orgId, input.source, input.externalId, input.resource, agentKey],
  );
  return result.rows[0] ?? null;
}

export async function getFinding(
  orgId: string,
  findingId: string,
): Promise<VulnFindingRow | null> {
  const db = await getDb();
  const result = await db.query<VulnFindingRow>(
    `SELECT * FROM vuln_findings WHERE org_id = $1 AND id = $2 LIMIT 1`,
    [orgId, findingId],
  );
  return result.rows[0] ?? null;
}

export async function resolveFinding(
  orgId: string,
  findingId: string,
): Promise<VulnFindingRow | null> {
  const existing = await getFinding(orgId, findingId);
  if (!existing) return null;
  const db = await getDb();
  await db.query(
    `UPDATE vuln_findings
     SET status = 'resolved', resolved_at = NOW()
     WHERE org_id = $1 AND id = $2`,
    [orgId, findingId],
  );
  return getFinding(orgId, findingId);
}

export type UpsertFindingsResult = {
  written: number;
  alarmsRaised: number;
};

export async function upsertFindings(
  orgId: string,
  findings: NormalizedFinding[],
): Promise<number> {
  const result = await upsertFindingsDetailed(orgId, findings);
  return result.written;
}

export async function upsertFindingsDetailed(
  orgId: string,
  findings: NormalizedFinding[],
): Promise<UpsertFindingsResult> {
  if (findings.length === 0) return { written: 0, alarmsRaised: 0 };
  const db = await getDb();
  let written = 0;
  let alarmsRaised = 0;
  for (const f of findings) {
    const agentId = f.agentId?.trim() || null;
    const agentKey = agentId ?? "";
    const prior = await findFindingByNaturalKey(orgId, {
      source: f.source,
      externalId: f.externalId,
      resource: f.resource,
      agentId,
    });
    const isNew = !prior;
    // Throwaway id on conflict — natural key UPSERT keeps the existing PK.
    const id = newId("vuln");

    await db.query(
      `INSERT INTO vuln_findings (
        id, org_id, source, external_id, title, severity,
        package_name, package_version, fixed_version, resource,
        cve, url, status, raw_json, agent_id, agent_key,
        first_seen_at, last_seen_at, resolved_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'open',$13,$14,$15,NOW(),NOW(),NULL
      )
      ON CONFLICT (org_id, source, external_id, resource, agent_key) DO UPDATE SET
        title = EXCLUDED.title,
        severity = EXCLUDED.severity,
        package_name = EXCLUDED.package_name,
        package_version = EXCLUDED.package_version,
        fixed_version = EXCLUDED.fixed_version,
        cve = EXCLUDED.cve,
        url = EXCLUDED.url,
        status = 'open',
        raw_json = EXCLUDED.raw_json,
        agent_id = EXCLUDED.agent_id,
        resolved_at = NULL,
        last_seen_at = NOW()`,
      [
        id,
        orgId,
        f.source,
        f.externalId,
        f.title,
        f.severity,
        f.packageName ?? null,
        f.packageVersion ?? null,
        f.fixedVersion ?? null,
        f.resource,
        f.cve ?? null,
        safeHttpUrl(f.url),
        JSON.stringify(f.raw ?? {}),
        agentId,
        agentKey,
      ],
    );
    written += 1;

    if (isNew) {
      const row = await findFindingByNaturalKey(orgId, {
        source: f.source,
        externalId: f.externalId,
        resource: f.resource,
        agentId,
      });
      if (row) {
        const alarm = await maybeRaiseFindingAlarm(orgId, row);
        if (alarm.raised) alarmsRaised += 1;
      }
    }
  }
  return { written, alarmsRaised };
}

export async function listFindings(
  orgId: string,
  opts?: { source?: VulnSource; agentId?: string; limit?: number },
): Promise<VulnFindingRow[]> {
  const db = await getDb();
  const limit = Math.min(500, Math.max(1, opts?.limit ?? 200));
  const clauses = ["org_id = $1", "status = 'open'"];
  const params: unknown[] = [orgId];
  if (opts?.source) {
    params.push(opts.source);
    clauses.push(`source = $${params.length}`);
  }
  if (opts?.agentId) {
    params.push(opts.agentId);
    clauses.push(`agent_id = $${params.length}`);
  }
  params.push(limit);
  const result = await db.query<VulnFindingRow>(
    `SELECT * FROM vuln_findings
     WHERE ${clauses.join(" AND ")}
     ORDER BY
       CASE severity
         WHEN 'critical' THEN 0
         WHEN 'high' THEN 1
         WHEN 'medium' THEN 2
         WHEN 'low' THEN 3
         ELSE 4
       END,
       last_seen_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return result.rows;
}
