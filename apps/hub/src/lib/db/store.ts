import { createHash } from "node:crypto";
import { getDb } from "./client";
import type {
  AgentRow,
  AgentTokenRow,
  AlertChannelKind,
  AlertChannelRow,
  AlertEventRow,
  AlertEventStatus,
  AlertRuleRow,
  NotificationPrefsRow,
  Organization,
  Role,
  User,
} from "./types";
import type { MutePresetMinutes } from "@/lib/alerts/fingerprint";
import { newAgentSecret, newAgentToken, newId } from "@/lib/ids";
import { safeEqual } from "@/lib/http-guard/compare";
import { matchesBootstrapToken } from "@/lib/agents/bootstrap";
import { openChannel, openUser, sealJson, sealText } from "./secrets";
import { hashPassword } from "@/lib/auth/password";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
} from "@/lib/mfa/totp";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Env bootstrap token reader; the accepted token is decided by matchesBootstrapToken. */
export { resolveBootstrapToken } from "@/lib/agents/bootstrap";

/**
 * Org used when an agent registers with the bootstrap token.
 * Prefer (in order): HEIMDALL_ORG_ID, an org that already has admin users,
 * oldest org, or create a fresh "Bootstrap" org.
 */
export async function ensureBootstrapOrg(): Promise<Organization> {
  const pinned = process.env.HEIMDALL_ORG_ID?.trim();
  if (pinned) {
    const db = await getDb();
    const byId = await db.query<Organization>(
      `SELECT * FROM organizations WHERE id = $1 LIMIT 1`,
      [pinned],
    );
    if (byId.rows[0]) return byId.rows[0];
  }

  const withAdmins = await getOrgWithAdmins();
  if (withAdmins) return withAdmins;

  const existing = await getPrimaryOrg();
  if (existing) return existing;

  const db = await getDb();
  const orgId = newId("org");
  await db.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [
    orgId,
    "Bootstrap",
  ]);
  return (await getPrimaryOrg())!;
}

/** Oldest org that has at least one admin user (wizard / Heimdall Ops case). */
export async function getOrgWithAdmins(): Promise<Organization | null> {
  const db = await getDb();
  const result = await db.query<Organization>(
    `SELECT o.*
     FROM organizations o
     WHERE EXISTS (
       SELECT 1 FROM users u
       WHERE u.org_id = o.id AND u.role = 'admin'
     )
     ORDER BY o.created_at ASC
     LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

/** Oldest org with no users (empty Bootstrap left by early agent register). */
export async function getUserlessOrg(): Promise<Organization | null> {
  const db = await getDb();
  const result = await db.query<Organization>(
    `SELECT o.*
     FROM organizations o
     WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.org_id = o.id)
     ORDER BY o.created_at ASC
     LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

export async function isSetupComplete(): Promise<boolean> {
  const db = await getDb();
  const result = await db.query<{ completed: boolean }>(
    "SELECT completed FROM setup_state WHERE id = $1",
    ["singleton"],
  );
  return Boolean(result.rows[0]?.completed);
}

export async function getSetupState() {
  const db = await getDb();
  const result = await db.query<{
    current_step: string;
    completed: boolean;
  }>("SELECT current_step, completed FROM setup_state WHERE id = $1", [
    "singleton",
  ]);
  return result.rows[0] ?? { current_step: "org_admin", completed: false };
}

export async function setSetupStep(step: string, completed = false) {
  const db = await getDb();
  await db.query(
    `UPDATE setup_state
     SET current_step = $1, completed = $2, updated_at = NOW()
     WHERE id = 'singleton'`,
    [step, completed],
  );
}

export async function createOrgAndAdmin(input: {
  orgName: string;
  adminName: string;
  email: string;
  password: string;
}): Promise<{ org: Organization; user: User }> {
  const db = await getDb();
  const userId = newId("usr");
  const passwordHash = await hashPassword(input.password);

  // Adopt empty Bootstrap (agent registered before wizard) instead of a second org.
  const adoptable = await getUserlessOrg();
  let orgId: string;
  if (adoptable) {
    orgId = adoptable.id;
    await db.query(`UPDATE organizations SET name = $1 WHERE id = $2`, [
      input.orgName,
      orgId,
    ]);
  } else {
    orgId = newId("org");
    await db.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [
      orgId,
      input.orgName,
    ]);
  }

  await db.query(
    `INSERT INTO users (id, org_id, email, name, password_hash, role, mfa_enrolled)
     VALUES ($1, $2, $3, $4, $5, 'admin', FALSE)`,
    [userId, orgId, input.email.toLowerCase(), input.adminName, passwordHash],
  );

  const org = (
    await db.query<Organization>(`SELECT * FROM organizations WHERE id = $1`, [
      orgId,
    ])
  ).rows[0];
  const user = (
    await db.query<User>(`SELECT * FROM users WHERE id = $1`, [userId])
  ).rows[0];

  await setSetupStep("channels");
  return { org, user };
}

export async function getPrimaryOrg(): Promise<Organization | null> {
  const db = await getDb();
  const result = await db.query<Organization>(
    `SELECT * FROM organizations ORDER BY created_at ASC LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const db = await getDb();
  const result = await db.query<User>(
    `SELECT * FROM users WHERE email = $1 LIMIT 1`,
    [email.toLowerCase()],
  );
  return openUser(result.rows[0] ?? null);
}

export async function findUserById(id: string): Promise<User | null> {
  const db = await getDb();
  const result = await db.query<User>(`SELECT * FROM users WHERE id = $1`, [
    id,
  ]);
  return openUser(result.rows[0] ?? null);
}

export async function listUsersByOrg(orgId: string): Promise<User[]> {
  const db = await getDb();
  const result = await db.query<User>(
    `SELECT * FROM users WHERE org_id = $1 ORDER BY created_at ASC`,
    [orgId],
  );
  return result.rows.map((u) => openUser(u));
}

export async function upsertAlertChannel(input: {
  orgId: string;
  kind: AlertChannelKind;
  enabled?: boolean;
  config: Record<string, unknown>;
}): Promise<AlertChannelRow> {
  const db = await getDb();
  const existing = await db.query<AlertChannelRow>(
    `SELECT * FROM alert_channels WHERE org_id = $1 AND kind = $2 LIMIT 1`,
    [input.orgId, input.kind],
  );
  const configJson = JSON.stringify(input.config);
  const sealed = sealJson(configJson);
  const enabled = input.enabled ?? true;

  if (existing.rows[0]) {
    await db.query(
      `UPDATE alert_channels SET enabled = $1, config_json = $2 WHERE id = $3`,
      [enabled, sealed, existing.rows[0].id],
    );
    return { ...existing.rows[0], enabled, config_json: configJson };
  }

  const id = newId("chn");
  await db.query(
    `INSERT INTO alert_channels (id, org_id, kind, enabled, config_json)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, input.orgId, input.kind, enabled, sealed],
  );
  const created = await db.query<AlertChannelRow>(
    `SELECT * FROM alert_channels WHERE id = $1`,
    [id],
  );
  return openChannel(created.rows[0]);
}

export async function listAlertChannels(orgId: string): Promise<AlertChannelRow[]> {
  const db = await getDb();
  const result = await db.query<AlertChannelRow>(
    `SELECT * FROM alert_channels WHERE org_id = $1 ORDER BY kind ASC`,
    [orgId],
  );
  return result.rows.map(openChannel);
}

export async function ensureDefaultThresholdRule(orgId: string): Promise<AlertRuleRow> {
  const db = await getDb();
  const existing = await db.query<AlertRuleRow>(
    `SELECT * FROM alert_rules WHERE org_id = $1 AND metric = 'agent_offline_minutes' LIMIT 1`,
    [orgId],
  );
  if (existing.rows[0]) return existing.rows[0];

  const id = newId("rul");
  await db.query(
    `INSERT INTO alert_rules (
       id, org_id, name, metric, operator, threshold, warn_threshold, alarm_threshold, enabled
     ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $6, TRUE)`,
    [id, orgId, "Agent offline", "agent_offline_minutes", "gte", 5],
  );
  const created = await db.query<AlertRuleRow>(
    `SELECT * FROM alert_rules WHERE id = $1`,
    [id],
  );
  return created.rows[0];
}

export async function listAlertRules(orgId: string): Promise<AlertRuleRow[]> {
  const db = await getDb();
  const result = await db.query<AlertRuleRow>(
    `SELECT * FROM alert_rules WHERE org_id = $1 ORDER BY created_at ASC`,
    [orgId],
  );
  return result.rows;
}

export async function getAlertRule(
  orgId: string,
  ruleId: string,
): Promise<AlertRuleRow | null> {
  const db = await getDb();
  const result = await db.query<AlertRuleRow>(
    `SELECT * FROM alert_rules WHERE org_id = $1 AND id = $2 LIMIT 1`,
    [orgId, ruleId],
  );
  return result.rows[0] ?? null;
}

export async function updateAlertRuleThresholds(input: {
  orgId: string;
  ruleId: string;
  warnThreshold?: number | null;
  alarmThreshold?: number;
  enabled?: boolean;
}): Promise<AlertRuleRow | null> {
  const existing = await getAlertRule(input.orgId, input.ruleId);
  if (!existing) return null;

  const warn =
    input.warnThreshold !== undefined
      ? input.warnThreshold
      : existing.warn_threshold;
  const alarm =
    input.alarmThreshold !== undefined
      ? input.alarmThreshold
      : (existing.alarm_threshold ?? existing.threshold);
  const enabled =
    input.enabled !== undefined ? input.enabled : existing.enabled;

  if (
    warn != null &&
    Number.isFinite(Number(warn)) &&
    Number.isFinite(Number(alarm)) &&
    Number(warn) >= Number(alarm) &&
    (existing.operator === "gte" || existing.operator === "gt")
  ) {
    throw Object.assign(new Error("warn threshold must be less than alarm"), {
      status: 400,
    });
  }

  const db = await getDb();
  await db.query(
    `UPDATE alert_rules
     SET warn_threshold = $3,
         alarm_threshold = $4,
         threshold = $4,
         enabled = $5
     WHERE org_id = $1 AND id = $2`,
    [input.orgId, input.ruleId, warn, alarm, enabled],
  );
  return getAlertRule(input.orgId, input.ruleId);
}

export type ListAlertEventsOptions = {
  limit?: number;
  /** Filter by status; omit for all. `open` includes expired mutes (reopened). */
  status?: AlertEventStatus | "open_queue";
  id?: string;
};

/** Reopen muted alerts whose mute window has elapsed. */
export async function reopenExpiredMutes(
  orgId: string,
  now = new Date(),
): Promise<number> {
  const db = await getDb();
  const result = await db.query(
    `UPDATE alert_events
     SET status = 'open', muted_until = NULL
     WHERE org_id = $1
       AND status = 'muted'
       AND muted_until IS NOT NULL
       AND muted_until <= $2`,
    [orgId, now.toISOString()],
  );
  return result.rowCount ?? 0;
}

export async function listAlertEvents(
  orgId: string,
  limitOrOpts: number | ListAlertEventsOptions = 50,
): Promise<AlertEventRow[]> {
  const opts: ListAlertEventsOptions =
    typeof limitOrOpts === "number" ? { limit: limitOrOpts } : limitOrOpts;
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  await reopenExpiredMutes(orgId);

  const db = await getDb();
  const params: unknown[] = [orgId];
  const clauses = ["org_id = $1"];

  if (opts.id) {
    params.push(opts.id);
    clauses.push(`id = $${params.length}`);
  }

  if (opts.status === "open_queue") {
    // Open queue: open + currently muted (still visible until dismiss/expiry reopen)
    clauses.push(`status IN ('open', 'muted')`);
  } else if (opts.status) {
    params.push(opts.status);
    clauses.push(`status = $${params.length}`);
  }

  params.push(limit);
  const result = await db.query<AlertEventRow>(
    `SELECT * FROM alert_events
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return result.rows;
}

export async function getAlertEvent(
  orgId: string,
  eventId: string,
): Promise<AlertEventRow | null> {
  await reopenExpiredMutes(orgId);
  const db = await getDb();
  const result = await db.query<AlertEventRow>(
    `SELECT * FROM alert_events WHERE org_id = $1 AND id = $2`,
    [orgId, eventId],
  );
  return result.rows[0] ?? null;
}

export async function insertAlertEvent(input: {
  id: string;
  orgId: string;
  ruleId?: string | null;
  severity: string;
  message: string;
  payload: unknown;
  fingerprint?: string | null;
  status?: AlertEventStatus;
}): Promise<AlertEventRow> {
  const db = await getDb();
  await db.query(
    `INSERT INTO alert_events (
       id, org_id, rule_id, severity, message, payload_json,
       status, fingerprint
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.id,
      input.orgId,
      input.ruleId ?? null,
      input.severity,
      input.message,
      JSON.stringify(input.payload ?? {}),
      input.status ?? "open",
      input.fingerprint ?? null,
    ],
  );
  const row = await getAlertEvent(input.orgId, input.id);
  if (!row) throw new Error("insertAlertEvent: row missing after insert");
  return row;
}

/** True when the latest event for this fingerprint is muted and not expired. */
export async function isFingerprintMuted(
  orgId: string,
  fingerprint: string,
  now = new Date(),
): Promise<boolean> {
  await reopenExpiredMutes(orgId, now);
  const db = await getDb();
  const result = await db.query<{ status: string; muted_until: string | null }>(
    `SELECT status, muted_until FROM alert_events
     WHERE org_id = $1 AND fingerprint = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [orgId, fingerprint],
  );
  const row = result.rows[0];
  if (!row || row.status !== "muted") return false;
  if (!row.muted_until) return false;
  return new Date(row.muted_until).getTime() > now.getTime();
}

export async function muteAlertEvent(input: {
  orgId: string;
  eventId: string;
  minutes: MutePresetMinutes;
  now?: Date;
}): Promise<AlertEventRow | null> {
  const now = input.now ?? new Date();
  const mutedUntil = new Date(now.getTime() + input.minutes * 60_000);
  const db = await getDb();
  const existing = await getAlertEvent(input.orgId, input.eventId);
  if (!existing || existing.status === "dismissed" || existing.status === "resolved") return null;

  await db.query(
    `UPDATE alert_events
     SET status = 'muted', muted_until = $3, dismissed_at = NULL, dismissed_by = NULL
     WHERE org_id = $1 AND id = $2`,
    [input.orgId, input.eventId, mutedUntil.toISOString()],
  );

  // Also mute any other open rows sharing the fingerprint so the gate is consistent
  if (existing.fingerprint) {
    await db.query(
      `UPDATE alert_events
       SET status = 'muted', muted_until = $3
       WHERE org_id = $1
         AND fingerprint = $2
         AND status IN ('open', 'muted')
         AND id <> $4`,
      [
        input.orgId,
        existing.fingerprint,
        mutedUntil.toISOString(),
        input.eventId,
      ],
    );
  }

  return getAlertEvent(input.orgId, input.eventId);
}

export async function dismissAlertEvent(input: {
  orgId: string;
  eventId: string;
  dismissedBy: string;
  now?: Date;
}): Promise<AlertEventRow | null> {
  const now = input.now ?? new Date();
  const existing = await getAlertEvent(input.orgId, input.eventId);
  if (!existing) return null;
  const db = await getDb();
  await db.query(
    `UPDATE alert_events
     SET status = 'dismissed',
         dismissed_at = $3,
         dismissed_by = $4,
         muted_until = NULL
     WHERE org_id = $1 AND id = $2`,
    [input.orgId, input.eventId, now.toISOString(), input.dismissedBy],
  );
  return getAlertEvent(input.orgId, input.eventId);
}

export async function unmuteAlertEvent(input: {
  orgId: string;
  eventId: string;
}): Promise<AlertEventRow | null> {
  const existing = await getAlertEvent(input.orgId, input.eventId);
  if (!existing || existing.status === "dismissed" || existing.status === "resolved") return null;
  const db = await getDb();
  await db.query(
    `UPDATE alert_events
     SET status = 'open', muted_until = NULL
     WHERE org_id = $1 AND id = $2`,
    [input.orgId, input.eventId],
  );
  if (existing.fingerprint) {
    await db.query(
      `UPDATE alert_events
       SET status = 'open', muted_until = NULL
       WHERE org_id = $1
         AND fingerprint = $2
         AND status = 'muted'`,
      [input.orgId, existing.fingerprint],
    );
  }
  return getAlertEvent(input.orgId, input.eventId);
}

export async function listNotificationPrefs(
  orgId: string,
): Promise<NotificationPrefsRow[]> {
  const db = await getDb();
  const result = await db.query<NotificationPrefsRow>(
    `SELECT * FROM user_notification_prefs WHERE org_id = $1`,
    [orgId],
  );
  return result.rows;
}

export async function getNotificationPrefs(
  userId: string,
): Promise<NotificationPrefsRow | null> {
  const db = await getDb();
  const result = await db.query<NotificationPrefsRow>(
    `SELECT * FROM user_notification_prefs WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function getOrCreateNotificationPrefs(input: {
  userId: string;
  orgId: string;
}): Promise<NotificationPrefsRow> {
  const existing = await getNotificationPrefs(input.userId);
  if (existing) return existing;
  const db = await getDb();
  await db.query(
    `INSERT INTO user_notification_prefs (user_id, org_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [input.userId, input.orgId],
  );
  return (await getNotificationPrefs(input.userId))!;
}

export async function upsertNotificationPrefs(input: {
  userId: string;
  orgId: string;
  notifySmtp?: boolean;
  notifySlack?: boolean;
  notifyDiscord?: boolean;
  notifySms?: boolean;
  smsPhone?: string | null;
  quietHoursEnabled?: boolean;
  quietStart?: string;
  quietEnd?: string;
  timezone?: string;
}): Promise<NotificationPrefsRow> {
  const current = await getOrCreateNotificationPrefs({
    userId: input.userId,
    orgId: input.orgId,
  });
  const db = await getDb();
  const next = {
    notify_smtp: input.notifySmtp ?? current.notify_smtp,
    notify_slack: input.notifySlack ?? current.notify_slack,
    notify_discord: input.notifyDiscord ?? current.notify_discord,
    notify_sms: input.notifySms ?? current.notify_sms,
    sms_phone:
      input.smsPhone !== undefined ? input.smsPhone : current.sms_phone,
    quiet_hours_enabled:
      input.quietHoursEnabled ?? current.quiet_hours_enabled,
    quiet_start: input.quietStart ?? current.quiet_start,
    quiet_end: input.quietEnd ?? current.quiet_end,
    timezone: input.timezone ?? current.timezone,
  };
  await db.query(
    `UPDATE user_notification_prefs SET
      notify_smtp = $1,
      notify_slack = $2,
      notify_discord = $3,
      notify_sms = $4,
      sms_phone = $5,
      quiet_hours_enabled = $6,
      quiet_start = $7,
      quiet_end = $8,
      timezone = $9,
      updated_at = NOW()
     WHERE user_id = $10`,
    [
      next.notify_smtp,
      next.notify_slack,
      next.notify_discord,
      next.notify_sms,
      next.sms_phone,
      next.quiet_hours_enabled,
      next.quiet_start,
      next.quiet_end,
      next.timezone,
      input.userId,
    ],
  );
  return (await getNotificationPrefs(input.userId))!;
}

export async function createAgentToken(input: {
  orgId: string;
  name: string;
  createdBy?: string;
  expiresAt?: Date | null;
  maxUses?: number | null;
}): Promise<{ row: AgentTokenRow; token: string }> {
  const db = await getDb();
  const token = newAgentToken();
  const id = newId("tok");
  const tokenHash = hashToken(token);
  const hint = `${token.slice(0, 6)}…${token.slice(-4)}`;

  await db.query(
    `INSERT INTO agent_tokens (id, org_id, name, token_hash, token_hint, created_by, expires_at, max_uses)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, input.orgId, input.name, tokenHash, hint, input.createdBy ?? null, input.expiresAt ?? null, input.maxUses ?? null],
  );
  const row = (
    await db.query<AgentTokenRow>(`SELECT * FROM agent_tokens WHERE id = $1`, [
      id,
    ])
  ).rows[0];
  return { row, token };
}

export async function findActiveToken(token: string): Promise<AgentTokenRow | null> {
  const db = await getDb();
  const result = await db.query<AgentTokenRow>(
    `SELECT * FROM agent_tokens WHERE token_hash = $1 AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`,
    [hashToken(token)],
  );
  return result.rows[0] ?? null;
}

export async function ensureCluster(
  orgId: string,
  clusterId: string,
  name?: string,
): Promise<void> {
  const { ensureClusterRecord } = await import("@/lib/clusters/store");
  await ensureClusterRecord({ orgId, clusterId, name });
}

export type RegisterOutcome =
  | { ok: true; agent: AgentRow; agentSecret?: string }
  | { ok: false; error: string; status: number };

/**
 * Register (or re-register) an agent.
 * - Token: active enrollment token (not expired, uses left) or the bootstrap/legacy token.
 * - Existing (org, hostname) row: allowed only with that agent's secret (no rotation),
 *   or if the row predates secrets (adopt + upgrade). Otherwise 409 hostname_in_use.
 * - New / upgraded rows get a fresh `hda_` secret, returned once and stored as a hash.
 */
export async function registerAgentPersistent(input: {
  token: string;
  hostname: string;
  version: string;
  clusterId?: string;
  agentSecret?: string;
}): Promise<RegisterOutcome> {
  const token = input.token?.trim();
  const hostname = input.hostname?.trim();
  const version = input.version?.trim();
  const clusterId = input.clusterId?.trim() || "default";
  const presented = input.agentSecret?.trim() || "";
  if (!token) return { ok: false, error: "token is required", status: 400 };
  if (!hostname) return { ok: false, error: "hostname is required", status: 400 };
  if (!version) return { ok: false, error: "version is required", status: 400 };

  const db = await getDb();

  const tokenRow = await findActiveToken(token);
  const usedBootstrap = !tokenRow && (await matchesBootstrapToken(token));
  let orgId: string;
  if (tokenRow) orgId = tokenRow.org_id;
  else if (usedBootstrap) orgId = (await ensureBootstrapOrg()).id;
  else {
    // An installed agent re-registers on every start with its configured token plus its saved
    // secret. Once that token has expired or been revoked (or the bootstrap token rotated or
    // disabled), the secret alone proves identity: keep the agent where it is.
    if (presented) {
      const owner = (
        await db.query<AgentRow>(`SELECT * FROM agents WHERE secret_hash = $1 LIMIT 1`, [hashToken(presented)])
      ).rows[0];
      if (owner && owner.hostname === hostname) {
        if (owner.revoked_at) return { ok: false, error: "agent_revoked", status: 403 };
        await ensureCluster(owner.org_id, clusterId);
        await db.query(
          `UPDATE agents SET version = $1, last_seen_at = NOW(), cluster_id = $2 WHERE id = $3`,
          [version, clusterId, owner.id],
        );
        return { ok: true, agent: await loadAgent(owner.id) };
      }
    }
    return { ok: false, error: "invalid agent token", status: 401 };
  }

  await ensureCluster(orgId, clusterId);

  // Decide which row (if any) this registration targets.
  let target = (
    await db.query<AgentRow>(`SELECT * FROM agents WHERE org_id = $1 AND hostname = $2 LIMIT 1`, [orgId, hostname])
  ).rows[0];
  let moveOrg = false;
  if (!target && usedBootstrap) {
    // Bootstrap re-register: adopt a same-hostname row from another org (stale Bootstrap org).
    target = (
      await db.query<AgentRow>(
        `SELECT * FROM agents WHERE hostname = $1 AND org_id <> $2 ORDER BY registered_at ASC LIMIT 1`,
        [hostname, orgId],
      )
    ).rows[0];
    moveOrg = Boolean(target);
  }

  if (target) {
    const ownSecret = presented && target.secret_hash && safeEqual(hashToken(presented), target.secret_hash);
    if (target.revoked_at) {
      return { ok: false, error: "agent_revoked", status: 403 };
    }
    if (target.secret_hash && !ownSecret) {
      return { ok: false, error: "hostname_in_use", status: 409 };
    }
    if (ownSecret) {
      await db.query(
        `UPDATE agents SET org_id = $1, version = $2, last_seen_at = NOW(), cluster_id = $3 WHERE id = $4`,
        [moveOrg ? orgId : target.org_id, version, clusterId, target.id],
      );
      return { ok: true, agent: await loadAgent(target.id) };
    }
  }

  // New agent, or legacy row without a secret (upgrade): consume an enrollment use, mint a secret.
  if (tokenRow) {
    const used = await db.query(
      `UPDATE agent_tokens SET use_count = use_count + 1
       WHERE id = $1 AND (max_uses IS NULL OR use_count < max_uses) RETURNING id`,
      [tokenRow.id],
    );
    if (used.rows.length === 0) return { ok: false, error: "invalid agent token", status: 401 };
  }
  const agentSecret = newAgentSecret();
  const secretHash = hashToken(agentSecret);

  if (target) {
    await db.query(
      `UPDATE agents SET org_id = $1, version = $2, last_seen_at = NOW(), cluster_id = $3,
              token_id = COALESCE($4, token_id), secret_hash = $5
       WHERE id = $6`,
      [moveOrg ? orgId : target.org_id, version, clusterId, tokenRow?.id ?? null, secretHash, target.id],
    );
    return { ok: true, agent: await loadAgent(target.id), agentSecret };
  }

  const id = newId("agt");
  await db.query(
    `INSERT INTO agents (id, org_id, token_id, hostname, version, cluster_id, secret_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, orgId, tokenRow?.id ?? null, hostname, version, clusterId, secretHash],
  );
  return { ok: true, agent: await loadAgent(id), agentSecret };
}

async function loadAgent(id: string): Promise<AgentRow> {
  const db = await getDb();
  return (await db.query<AgentRow>(`SELECT * FROM agents WHERE id = $1`, [id])).rows[0];
}

export async function heartbeatAgentPersistent(
  agentId: string,
): Promise<
  | { ok: true; agent: AgentRow }
  | { ok: false; error: string; status: number }
> {
  const db = await getDb();
  const existing = await db.query<AgentRow>(
    `SELECT * FROM agents WHERE id = $1`,
    [agentId],
  );
  if (!existing.rows[0]) {
    return { ok: false, error: "agent not found", status: 404 };
  }
  await db.query(`UPDATE agents SET last_seen_at = NOW() WHERE id = $1`, [
    agentId,
  ]);
  const agent = (
    await db.query<AgentRow>(`SELECT * FROM agents WHERE id = $1`, [agentId])
  ).rows[0];
  return { ok: true, agent };
}

export async function listAgentsPersistent(orgId?: string): Promise<AgentRow[]> {
  const db = await getDb();
  if (orgId) {
    return (
      await db.query<AgentRow>(
        `SELECT * FROM agents WHERE org_id = $1 ORDER BY registered_at ASC`,
        [orgId],
      )
    ).rows;
  }
  return (
    await db.query<AgentRow>(`SELECT * FROM agents ORDER BY registered_at ASC`)
  ).rows;
}

/** Remove a fleet agent (metrics/containers/k8s cascade; log_events set null). */
export async function deleteAgentPersistent(
  agentId: string,
  orgId: string,
): Promise<
  { ok: true } | { ok: false; error: string; status: number }
> {
  const id = agentId?.trim();
  if (!id) return { ok: false, error: "agent id is required", status: 400 };
  const db = await getDb();
  const existing = await db.query<AgentRow>(
    `SELECT * FROM agents WHERE id = $1 AND org_id = $2 LIMIT 1`,
    [id, orgId],
  );
  if (!existing.rows[0]) {
    return { ok: false, error: "agent not found", status: 404 };
  }
  await db.query(`DELETE FROM agents WHERE id = $1 AND org_id = $2`, [
    id,
    orgId,
  ]);
  return { ok: true };
}

export async function markSetupComplete(orgId: string) {
  const db = await getDb();
  await db.query(
    `UPDATE organizations SET setup_completed_at = NOW() WHERE id = $1`,
    [orgId],
  );
  await setSetupStep("done", true);
}

export async function setUserTotpSecret(userId: string, secret: string) {
  const db = await getDb();
  await db.query(`UPDATE users SET totp_secret = $1 WHERE id = $2`, [
    sealText(secret),
    userId,
  ]);
}

export async function setUserTotpPending(userId: string, secret: string) {
  const db = await getDb();
  await db.query(`UPDATE users SET totp_pending = $1 WHERE id = $2`, [
    sealText(secret),
    userId,
  ]);
}

/** Move totp_pending -> totp_secret; returns false if nothing was pending. */
export async function promoteTotpPending(userId: string): Promise<boolean> {
  const db = await getDb();
  const r = await db.query(
    `UPDATE users SET totp_secret = totp_pending, totp_pending = NULL
     WHERE id = $1 AND totp_pending IS NOT NULL RETURNING id`,
    [userId],
  );
  return r.rows.length > 0;
}

export async function markMfaEnrolled(userId: string) {
  const db = await getDb();
  await db.query(`UPDATE users SET mfa_enrolled = TRUE WHERE id = $1`, [
    userId,
  ]);
}

export async function replaceRecoveryCodes(userId: string): Promise<string[]> {
  const db = await getDb();
  await db.query(`DELETE FROM recovery_codes WHERE user_id = $1`, [userId]);
  const codes = generateRecoveryCodes();
  for (const code of codes) {
    await db.query(
      `INSERT INTO recovery_codes (id, user_id, code_hash) VALUES ($1, $2, $3)`,
      [newId("rc"), userId, hashRecoveryCode(code)],
    );
  }
  return codes;
}

export async function consumeRecoveryCode(
  userId: string,
  code: string,
): Promise<boolean> {
  const db = await getDb();
  const hash = hashRecoveryCode(code);
  const result = await db.query<{ id: string }>(
    `SELECT id FROM recovery_codes
     WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
     LIMIT 1`,
    [userId, hash],
  );
  if (!result.rows[0]) return false;
  await db.query(`UPDATE recovery_codes SET used_at = NOW() WHERE id = $1`, [
    result.rows[0].id,
  ]);
  return true;
}

export async function saveWebAuthnCredential(input: {
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports?: string[];
}) {
  const db = await getDb();
  await db.query(
    `INSERT INTO webauthn_credentials (id, user_id, credential_id, public_key, counter, transports)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      newId("wa"),
      input.userId,
      input.credentialId,
      input.publicKey,
      input.counter,
      input.transports ? JSON.stringify(input.transports) : null,
    ],
  );
}

export async function listWebAuthnCredentials(userId: string) {
  const db = await getDb();
  return (
    await db.query<{
      id: string;
      credential_id: string;
      public_key: string;
      counter: number | string;
      transports: string | null;
    }>(`SELECT * FROM webauthn_credentials WHERE user_id = $1`, [userId])
  ).rows;
}

export async function updateWebAuthnCounter(
  credentialId: string,
  counter: number,
) {
  const db = await getDb();
  await db.query(
    `UPDATE webauthn_credentials SET counter = $1 WHERE credential_id = $2`,
    [counter, credentialId],
  );
}

export async function createUser(input: {
  orgId: string;
  email: string;
  name: string;
  password: string;
  role: Role;
}): Promise<User> {
  const db = await getDb();
  const id = newId("usr");
  const passwordHash = await hashPassword(input.password);
  await db.query(
    `INSERT INTO users (id, org_id, email, name, password_hash, role)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      input.orgId,
      input.email.toLowerCase(),
      input.name,
      passwordHash,
      input.role,
    ],
  );
  return (await findUserById(id))!;
}

/** Enrollment tokens for an org (never returns the token itself, only its hint). */
export async function listAgentTokens(orgId: string): Promise<AgentTokenRow[]> {
  const db = await getDb();
  return (
    await db.query<AgentTokenRow>(`SELECT * FROM agent_tokens WHERE org_id = $1 ORDER BY created_at DESC`, [orgId])
  ).rows;
}

export async function revokeAgentToken(id: string, orgId: string): Promise<boolean> {
  const db = await getDb();
  const r = await db.query(
    `UPDATE agent_tokens SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = $1 AND org_id = $2 RETURNING id`,
    [id, orgId],
  );
  return r.rows.length > 0;
}

/** Revoke an agent: all its credentials (secret and legacy tokens) stop working until re-enrolled. */
export async function revokeAgentPersistent(id: string, orgId: string): Promise<boolean> {
  const db = await getDb();
  const r = await db.query(
    `UPDATE agents SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = $1 AND org_id = $2 RETURNING id`,
    [id, orgId],
  );
  return r.rows.length > 0;
}

/** Clear the agent's secret and revocation so the next register adopts the row and mints a new secret. */
export async function reenrollAgentPersistent(id: string, orgId: string): Promise<boolean> {
  const db = await getDb();
  const r = await db.query(
    `UPDATE agents SET secret_hash = NULL, revoked_at = NULL, legacy_warned_at = NULL WHERE id = $1 AND org_id = $2 RETURNING id`,
    [id, orgId],
  );
  return r.rows.length > 0;
}

/** Metrics that only emit a sample while bad; absence in an ingest means recovered. */
function isEventMetric(metric: string): boolean {
  return !(
    metric === "cpu_percent" ||
    metric === "mem_percent" ||
    metric === "disk_percent" ||
    metric.startsWith("disk_percent:")
  );
}

/**
 * Auto-close open/muted alerts for an agent whose condition has cleared.
 * `breaching` = fingerprints still over threshold in this ingest; `healthy` =
 * fingerprints seen and under threshold. Continuous metrics (cpu/mem/disk) need
 * a healthy sample (a partial payload must not resolve them); event-style
 * metrics (mount_missing, container_*, k8s) resolve when no longer reported.
 */
export async function resolveRecoveredAlerts(input: {
  orgId: string;
  agentId: string;
  breaching: Set<string>;
  healthy: Set<string>;
  now?: Date;
}): Promise<ResolvedAlertEvent[]> {
  const db = await getDb();
  const open = await db.query<{
    id: string;
    fingerprint: string;
    payload_json: string;
    rule_id: string;
    severity: string;
    status: AlertEventStatus;
    created_at: string;
  }>(
    `SELECT id, fingerprint, payload_json, rule_id, severity, status, created_at FROM alert_events
     WHERE org_id = $1 AND status IN ('open', 'muted')
       AND rule_id IS NOT NULL AND fingerprint IS NOT NULL`,
    [input.orgId],
  );
  const picked: ResolvedAlertEvent[] = [];
  for (const row of open.rows) {
    let payload: ResolvedAlertEvent["payload"] = {};
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      continue;
    }
    if (payload.agentId !== input.agentId) continue;
    if (input.breaching.has(row.fingerprint)) continue;
    const metric = payload.sample?.metric ?? "";
    if (!input.healthy.has(row.fingerprint) && !isEventMetric(metric)) continue;
    picked.push({
      id: row.id,
      ruleId: row.rule_id,
      fingerprint: row.fingerprint,
      severity: row.severity,
      previousStatus: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      payload,
    });
  }
  if (picked.length === 0) return [];
  // Conditional on status so a concurrent ingest cannot resolve (and notify) twice.
  const result = await db.query<{ id: string }>(
    `UPDATE alert_events
     SET status = 'resolved', resolved_at = $2, muted_until = NULL
     WHERE org_id = $1 AND id = ANY($3::text[]) AND status IN ('open', 'muted')
     RETURNING id`,
    [input.orgId, (input.now ?? new Date()).toISOString(), picked.map((p) => p.id)],
  );
  const updated = new Set(result.rows.map((r) => r.id));
  return picked.filter((p) => updated.has(p.id));
}

export type ResolvedAlertEvent = {
  id: string;
  ruleId: string;
  fingerprint: string;
  severity: string;
  /** Status before resolution: "open" alerts notified; "muted" ones were silenced. */
  previousStatus: AlertEventStatus;
  createdAt: string;
  payload: {
    agentId?: string;
    hostname?: string;
    band?: string;
    mountPath?: string;
    sample?: { metric?: string; value?: number };
  };
};

/**
 * Dismiss every open/muted alert created at or before the cutoff
 * (olderThanDays = 0 dismisses all). Returns the number dismissed.
 */
export async function dismissAlertEventsBulk(input: {
  orgId: string;
  dismissedBy: string;
  olderThanDays: number;
  now?: Date;
}): Promise<number> {
  const now = input.now ?? new Date();
  const cutoff = new Date(
    now.getTime() - Math.max(0, input.olderThanDays) * 86_400_000,
  );
  const db = await getDb();
  const result = await db.query(
    `UPDATE alert_events
     SET status = 'dismissed', dismissed_at = $3, dismissed_by = $4, muted_until = NULL
     WHERE org_id = $1 AND status IN ('open', 'muted') AND created_at <= $2
     RETURNING id`,
    [input.orgId, cutoff.toISOString(), now.toISOString(), input.dismissedBy],
  );
  return result.rows.length;
}

/** One enrollment token in this org (any state), or null. */
export async function getAgentToken(id: string, orgId: string): Promise<AgentTokenRow | null> {
  const db = await getDb();
  const res = await db.query<AgentTokenRow>(
    `SELECT * FROM agent_tokens WHERE id = $1 AND org_id = $2 LIMIT 1`,
    [id, orgId],
  );
  return res.rows[0] ?? null;
}
