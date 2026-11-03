import { getDb } from "@/lib/db/client";
import type { ClusterRow, OrgSettingsRow } from "@/lib/db/types";
import { newId } from "@/lib/ids";

export async function listClusters(orgId: string): Promise<ClusterRow[]> {
  const db = await getDb();
  const result = await db.query<ClusterRow>(
    `SELECT * FROM clusters WHERE org_id = $1 ORDER BY cluster_id ASC`,
    [orgId],
  );
  return result.rows;
}

export async function ensureClusterRecord(input: {
  orgId: string;
  clusterId: string;
  name?: string;
}): Promise<ClusterRow> {
  const clusterId = input.clusterId.trim() || "default";
  const db = await getDb();
  const existing = await db.query<ClusterRow>(
    `SELECT * FROM clusters WHERE org_id = $1 AND cluster_id = $2 LIMIT 1`,
    [input.orgId, clusterId],
  );
  if (existing.rows[0]) {
    if (input.name && input.name !== existing.rows[0].name) {
      await db.query(`UPDATE clusters SET name = $1 WHERE id = $2`, [
        input.name,
        existing.rows[0].id,
      ]);
      return (await getClusterByKey(input.orgId, clusterId))!;
    }
    return existing.rows[0];
  }

  const all = await listClusters(input.orgId);
  const makeActive = all.length === 0;
  const id = newId("clu");
  await db.query(
    `INSERT INTO clusters (id, org_id, cluster_id, name, is_active)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, input.orgId, clusterId, input.name?.trim() || clusterId, makeActive],
  );
  if (makeActive) {
    await setActiveCluster(input.orgId, clusterId);
  }
  return (await getClusterByKey(input.orgId, clusterId))!;
}

export async function getClusterByKey(
  orgId: string,
  clusterId: string,
): Promise<ClusterRow | null> {
  const db = await getDb();
  const result = await db.query<ClusterRow>(
    `SELECT * FROM clusters WHERE org_id = $1 AND cluster_id = $2 LIMIT 1`,
    [orgId, clusterId],
  );
  return result.rows[0] ?? null;
}

export async function renameCluster(input: {
  orgId: string;
  clusterId: string;
  name: string;
}): Promise<ClusterRow | null> {
  const db = await getDb();
  await db.query(
    `UPDATE clusters SET name = $1 WHERE org_id = $2 AND cluster_id = $3`,
    [input.name.trim(), input.orgId, input.clusterId],
  );
  return getClusterByKey(input.orgId, input.clusterId);
}

export async function getOrgSettings(
  orgId: string,
): Promise<OrgSettingsRow> {
  const db = await getDb();
  const existing = await db.query<OrgSettingsRow>(
    `SELECT * FROM org_settings WHERE org_id = $1`,
    [orgId],
  );
  if (existing.rows[0]) return existing.rows[0];
  await db.query(
    `INSERT INTO org_settings (org_id, active_cluster_id)
     VALUES ($1, 'default')
     ON CONFLICT (org_id) DO NOTHING`,
    [orgId],
  );
  return (
    await db.query<OrgSettingsRow>(
      `SELECT * FROM org_settings WHERE org_id = $1`,
      [orgId],
    )
  ).rows[0];
}

export async function setActiveCluster(
  orgId: string,
  clusterId: string,
): Promise<OrgSettingsRow> {
  const db = await getDb();
  await ensureClusterRecord({ orgId, clusterId });
  await db.query(
    `UPDATE clusters SET is_active = (cluster_id = $1) WHERE org_id = $2`,
    [clusterId, orgId],
  );
  await db.query(
    `INSERT INTO org_settings (org_id, active_cluster_id, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (org_id) DO UPDATE SET
       active_cluster_id = EXCLUDED.active_cluster_id,
       updated_at = NOW()`,
    [orgId, clusterId],
  );
  return getOrgSettings(orgId);
}

export async function getActiveClusterId(orgId: string): Promise<string> {
  const settings = await getOrgSettings(orgId);
  return settings.active_cluster_id || "default";
}
