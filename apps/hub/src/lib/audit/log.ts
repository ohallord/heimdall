import { getDb } from "@/lib/db/client";
import { newId } from "@/lib/ids";
import { clientIp } from "@/lib/http-guard/rate-limit";

/** Dotted action names written to audit_log. Free-form strings are allowed; these are the ones we emit. */
export type AuditAction =
  | "security.sync_schedule.update"
  | "org.settings.update"
  | "alert.rule.update"
  | "agent_token.create"
  | "agent_token.revoke"
  | "agent_token.replace"
  | "bootstrap_token.rotate"
  | "bootstrap_token.disable"
  | "bootstrap_token.revert"
  | "oidc.provider.save"
  | "oidc.provider.delete"
  | "backup.export"
  | "backup.restore"
  | "security.connection.add"
  | "security.connection.remove"
  | "alert_channel.save"
  | "alert_channel.delete"
  | "uptime.check.create"
  | "uptime.check.update"
  | "uptime.check.delete"
  | (string & {});

export type AuditActor = { orgId?: string | null; userId?: string | null; email?: string | null };

const SECRET_KEY =
  /secret|token|password|passwd|api[-_]?key|authorization|credential|webhook|private|cookie|signature/i;

/** Copy of `detail` with secret-looking keys replaced, at any depth. */
export function redactDetail(value: unknown): Record<string, unknown> {
  const walk = (v: unknown, d: number): unknown => {
    if (d > 6) return "[truncated]";
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => walk(x, d + 1));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        out[k] = SECRET_KEY.test(k) ? "[redacted]" : walk(x, d + 1);
      }
      return out;
    }
    if (typeof v === "string" && v.length > 500) return `${v.slice(0, 500)}…`;
    return v;
  };
  const r = walk(value ?? {}, 0);
  return r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : { value: r };
}

/**
 * Append an audit entry. Never throws: an audit failure must not break the change it describes.
 * `detail` is redacted for secret-looking keys, but callers should not pass secrets at all.
 */
export async function recordAudit(input: {
  session: AuditActor;
  action: AuditAction;
  target?: string | null;
  detail?: unknown;
  request?: Request;
}): Promise<void> {
  if (!input.session.orgId) return;
  try {
    const db = await getDb();
    await db.query(
      `INSERT INTO audit_log (id, org_id, actor_user_id, actor_email, action, target, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        newId("aud"),
        input.session.orgId,
        input.session.userId ?? null,
        input.session.email ?? null,
        input.action,
        input.target ?? null,
        JSON.stringify(redactDetail(input.detail)),
        input.request ? clientIp(input.request) : null,
      ],
    );
  } catch (err) {
    console.error("[audit] failed to record entry", err instanceof Error ? err.message : err);
  }
}

export type AuditEntry = {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  target: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
};

type Row = {
  id: string;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  target: string | null;
  detail: string;
  ip: string | null;
  created_at: string | Date;
  cursor_ts: string;
};

export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 200;

/** Newest-first page. `cursor` is the opaque `nextCursor` of the previous page. */
export async function listAudit(
  orgId: string,
  opts: { action?: string; limit?: number; cursor?: string },
): Promise<{ rows: AuditEntry[]; nextCursor: string | null }> {
  const limit = Math.min(AUDIT_PAGE_MAX, Math.max(1, Math.floor(opts.limit ?? AUDIT_PAGE_DEFAULT)));
  const params: unknown[] = [orgId];
  let where = `org_id = $1`;
  if (opts.action) {
    params.push(opts.action);
    where += ` AND action = $${params.length}`;
  }
  if (opts.cursor) {
    const [ts, id] = Buffer.from(opts.cursor, "base64url").toString("utf8").split("|");
    if (ts && id && !Number.isNaN(Date.parse(ts))) {
      params.push(ts, id);
      where += ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length})`;
    }
  }
  params.push(limit + 1);
  const db = await getDb();
  const res = await db.query<Row>(
    `SELECT id, actor_user_id, actor_email, action, target, detail, ip, created_at,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
     FROM audit_log WHERE ${where}
     ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  const hasMore = res.rows.length > limit;
  const rows = res.rows.slice(0, limit).map<AuditEntry>((r) => {
    let detail: Record<string, unknown> = {};
    try {
      detail = JSON.parse(r.detail) as Record<string, unknown>;
    } catch {
      /* keep empty */
    }
    return {
      id: r.id,
      actorUserId: r.actor_user_id,
      actorEmail: r.actor_email,
      action: r.action,
      target: r.target,
      detail,
      ip: r.ip,
      createdAt: new Date(r.created_at).toISOString(),
    };
  });
  const lastRow = res.rows[rows.length - 1];
  // Microsecond-precision timestamp so rows inside the same millisecond are not skipped.
  const nextCursor =
    hasMore && lastRow ? Buffer.from(`${lastRow.cursor_ts}|${lastRow.id}`).toString("base64url") : null;
  return { rows, nextCursor };
}

/** Delete audit rows older than `cutoffIso` for the org. Returns the number removed. */
export async function purgeAudit(orgId: string, cutoffIso: string): Promise<number> {
  const db = await getDb();
  const res = await db.query(`DELETE FROM audit_log WHERE org_id = $1 AND created_at < $2 RETURNING id`, [
    orgId,
    cutoffIso,
  ]);
  return res.rowCount ?? 0;
}
