import { upsertAlertChannel } from "@/lib/db/store";
import { ensureClusterRecord, setActiveCluster } from "@/lib/clusters/store";
import { upsertOidcProvider } from "@/lib/oidc/store";
import { upsertSecurityConnection } from "@/lib/security/store";
import { getDb } from "@/lib/db/client";
import { newId } from "@/lib/ids";
import type { BackupPayload } from "./export";
import type { AlertChannelKind } from "@/lib/db/types";

export type RestoreResult = {
  clusters: number;
  channels: number;
  rules: number;
  remotes: number;
  oidcProviders: number;
};

export async function restoreOrgBackup(input: {
  orgId: string;
  backup: BackupPayload;
}): Promise<RestoreResult> {
  if (input.backup.version !== 1) {
    throw Object.assign(new Error("unsupported backup version"), { status: 400 });
  }

  let clusters = 0;
  for (const c of input.backup.clusters ?? []) {
    await ensureClusterRecord({
      orgId: input.orgId,
      clusterId: c.clusterId,
      name: c.name,
    });
    clusters += 1;
  }
  if (input.backup.settings?.activeClusterId) {
    await setActiveCluster(input.orgId, input.backup.settings.activeClusterId);
  }

  let channels = 0;
  for (const ch of input.backup.alertChannels ?? []) {
    const config = { ...ch.config };
    // Skip channels whose secrets were redacted unless they still look usable.
    if (JSON.stringify(config).includes("[redacted]") && ch.kind !== "slack") {
      // still restore structure with placeholder disabled
      await upsertAlertChannel({
        orgId: input.orgId,
        kind: ch.kind as AlertChannelKind,
        enabled: false,
        config,
      });
    } else {
      await upsertAlertChannel({
        orgId: input.orgId,
        kind: ch.kind as AlertChannelKind,
        enabled: ch.enabled,
        config,
      });
    }
    channels += 1;
  }

  const db = await getDb();
  let rules = 0;
  for (const rule of input.backup.alertRules ?? []) {
    const existing = await db.query(
      `SELECT id FROM alert_rules WHERE org_id = $1 AND metric = $2 LIMIT 1`,
      [input.orgId, rule.metric],
    );
    if (!existing.rows[0]) {
      const alarm = rule.alarmThreshold ?? rule.threshold;
      const warn = rule.warnThreshold ?? null;
      await db.query(
        `INSERT INTO alert_rules (
           id, org_id, name, metric, operator, threshold, warn_threshold, alarm_threshold, enabled
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          newId("rul"),
          input.orgId,
          rule.name,
          rule.metric,
          rule.operator,
          alarm,
          warn,
          alarm,
          rule.enabled,
        ],
      );
    }
    rules += 1;
  }

  let remotes = 0;
  for (const remote of input.backup.remotes ?? []) {
    const config = { ...remote.config };
    if (config.token === "[redacted]") {
      // Keep name registry without enabling until a fresh token is supplied.
      await upsertSecurityConnection({
        orgId: input.orgId,
        kind: remote.kind as "github" | "gitlab",
        name: remote.name,
        enabled: false,
        tokenHint: remote.tokenHint ?? undefined,
        config: { ...config, token: "" },
      });
    } else {
      await upsertSecurityConnection({
        orgId: input.orgId,
        kind: remote.kind as "github" | "gitlab",
        name: remote.name,
        enabled: remote.enabled,
        tokenHint: remote.tokenHint ?? undefined,
        config,
      });
    }
    remotes += 1;
  }

  let oidcProviders = 0;
  for (const p of input.backup.oidcProviders ?? []) {
    if (!p.clientSecret) continue;
    await upsertOidcProvider({
      orgId: input.orgId,
      name: p.name,
      issuer: p.issuer,
      clientId: p.clientId,
      clientSecret: p.clientSecret,
      scopes: p.scopes,
      enabled: p.enabled,
    });
    oidcProviders += 1;
  }

  return { clusters, channels, rules, remotes, oidcProviders };
}
