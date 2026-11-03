import {
  alertCooldownKey,
  shouldFireAlert,
} from "@/lib/alerts/cooldown";
import { evaluateRule } from "@/lib/alerts/engine";
import { alertFingerprint } from "@/lib/alerts/fingerprint";
import { alertDeepLink } from "@/lib/alerts/format";
import { areAlertsPaused } from "@/lib/alerts/pause";
import { enqueueAlert } from "@/lib/alerts/queue";
import { getDb } from "@/lib/db/client";
import type { AgentRow, LogEventRow } from "@/lib/db/types";
import {
  ensureDefaultThresholdRule,
  insertAlertEvent,
  isFingerprintMuted,
  listAlertChannels,
  listAlertRules,
  listNotificationPrefs,
} from "@/lib/db/store";
import { newId } from "@/lib/ids";
import {
  evaluateLogLine,
  highestSeverity,
  logMatchMetric,
  type LogMatch,
} from "./engine";
import { redactSecrets } from "./redact";
import { DEFAULT_LOG_RULES, logRuleAlerts } from "./rules";

export type LogLineInput = {
  source: string;
  line: string;
  observedAt?: string;
};

export type LogIngestResult =
  | {
      ok: true;
      accepted: number;
      matches: number;
      alertsFired: number;
    }
  | { ok: false; error: string; status: number };

async function ensureLogMatchRules(orgId: string) {
  await ensureDefaultThresholdRule(orgId);
  const db = await getDb();
  for (const rule of DEFAULT_LOG_RULES) {
    if (rule.alert === false) continue;
    const metric = logMatchMetric(rule.id);
    const existing = await db.query(
      `SELECT id FROM alert_rules WHERE org_id = $1 AND metric = $2 LIMIT 1`,
      [orgId, metric],
    );
    if (existing.rows[0]) continue;
    await db.query(
      `INSERT INTO alert_rules (
         id, org_id, name, metric, operator, threshold, warn_threshold, alarm_threshold, enabled
       ) VALUES ($1, $2, $3, $4, 'gte', 1, NULL, 1, TRUE)`,
      [newId("rul"), orgId, `Log: ${rule.name}`, metric],
    );
  }
}

/**
 * Org-scoped log ingest used by agent file-tail and OTLP `/v1/logs`.
 * `agentId` may be null (OTEL without heimdall.agent_id).
 */
export async function ingestLogLines(input: {
  orgId: string;
  agentId?: string | null;
  hostname?: string;
  lines: LogLineInput[];
  touchAgentLastSeen?: boolean;
}): Promise<LogIngestResult> {
  const orgId = input.orgId?.trim();
  if (!orgId) return { ok: false, error: "orgId is required", status: 400 };
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    return { ok: false, error: "lines[] is required", status: 400 };
  }

  const agentId = input.agentId?.trim() || null;
  const hostname = (input.hostname?.trim() || "otel").slice(0, 256);

  await ensureLogMatchRules(orgId);
  const alertRules = await listAlertRules(orgId);
  const channels = await listAlertChannels(orgId);
  const prefs = await listNotificationPrefs(orgId);

  let accepted = 0;
  let matchCount = 0;
  let alertsFired = 0;
  const db = await getDb();

  for (const item of input.lines.slice(0, 500)) {
    // Redact before anything else so secrets never reach storage or alerts.
    const line = redactSecrets(String(item.line ?? ""));
    if (!line.trim()) continue;
    const source = String(item.source ?? "unknown").slice(0, 512);
    const observedAt = item.observedAt
      ? new Date(item.observedAt).toISOString()
      : new Date().toISOString();
    const evaluated = evaluateLogLine(line);
    const matches = evaluated.matches;
    const severity = highestSeverity(matches);
    const id = newId("log");

    await db.query(
      `INSERT INTO log_events (
        id, org_id, agent_id, source, line, observed_at, matched_rules_json, severity
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        orgId,
        agentId,
        source,
        line.slice(0, 8000),
        observedAt,
        JSON.stringify(matches),
        severity,
      ],
    );
    accepted += 1;

    if (matches.length === 0) continue;
    matchCount += matches.length;

    if (areAlertsPaused()) continue;

    for (const match of matches) {
      if (!logRuleAlerts(match.ruleId)) continue;
      const sample = { metric: logMatchMetric(match.ruleId), value: 1 };
      for (const rule of alertRules) {
        if (!evaluateRule(rule, sample)) continue;
        const coolKey = alertCooldownKey({
          orgId,
          ruleId: rule.id,
          agentId: agentId ?? `otel:${hostname}`,
          metric: sample.metric,
        });
        if (!shouldFireAlert(coolKey)) continue;
        const fingerprint = alertFingerprint({
          orgId,
          ruleOrSource: rule.id,
          agentOrAlarmId: agentId ?? `otel:${hostname}`,
          metricOrName: sample.metric,
        });
        if (await isFingerprintMuted(orgId, fingerprint)) {
          continue;
        }
        const eventId = newId("evt");
        const alertSeverity =
          match.severity === "critical"
            ? ("critical" as const)
            : ("warning" as const);
        const payload = {
          subject: `${match.ruleName} on ${hostname}`,
          message: `[${match.category}] ${line.slice(0, 500)}`,
          severity: alertSeverity,
          hostname,
          deepLink: alertDeepLink(eventId),
          fields: [
            { label: "Host", value: hostname },
            { label: "Source", value: source },
            { label: "Category", value: match.category },
            { label: "Rule", value: match.ruleName },
            { label: "Severity", value: alertSeverity },
          ],
        };
        enqueueAlert({ channels, payload, prefs });
        await insertAlertEvent({
          id: eventId,
          orgId,
          ruleId: rule.id,
          severity: payload.severity,
          message: payload.message,
          fingerprint,
          payload: {
            agentId,
            hostname,
            source,
            match,
            logEventId: id,
          },
        });
        alertsFired += 1;
      }
    }
  }

  if (input.touchAgentLastSeen && agentId) {
    await db.query(`UPDATE agents SET last_seen_at = NOW() WHERE id = $1`, [
      agentId,
    ]);
  }

  return { ok: true, accepted, matches: matchCount, alertsFired };
}

export async function ingestAgentLogs(input: {
  agentId: string;
  lines: LogLineInput[];
}): Promise<LogIngestResult> {
  const agentId = input.agentId?.trim();
  if (!agentId) return { ok: false, error: "agentId is required", status: 400 };
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    return { ok: false, error: "lines[] is required", status: 400 };
  }

  const db = await getDb();
  const agentRes = await db.query<AgentRow>(`SELECT * FROM agents WHERE id = $1`, [
    agentId,
  ]);
  const agent = agentRes.rows[0];
  if (!agent) return { ok: false, error: "agent not found", status: 404 };

  return ingestLogLines({
    orgId: agent.org_id,
    agentId,
    hostname: agent.hostname,
    lines: input.lines,
    touchAgentLastSeen: true,
  });
}

export async function searchLogEvents(input: {
  orgId: string;
  q?: string;
  ruleId?: string;
  agentId?: string;
  matchesOnly?: boolean;
  limit?: number;
}): Promise<Array<LogEventRow & { matches: LogMatch[] }>> {
  const db = await getDb();
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  const clauses = [`org_id = $1`];
  const params: unknown[] = [input.orgId];
  let idx = 2;

  if (input.agentId) {
    clauses.push(`agent_id = $${idx++}`);
    params.push(input.agentId);
  }
  if (input.q?.trim()) {
    clauses.push(`line ILIKE $${idx++}`);
    params.push(`%${input.q.trim()}%`);
  }
  if (input.matchesOnly) {
    clauses.push(`matched_rules_json != '[]'`);
  }
  if (input.ruleId?.trim()) {
    clauses.push(`matched_rules_json LIKE $${idx++}`);
    params.push(`%"ruleId":"${input.ruleId.trim()}"%`);
  }

  params.push(limit);
  const result = await db.query<LogEventRow>(
    `SELECT * FROM log_events
     WHERE ${clauses.join(" AND ")}
     ORDER BY observed_at DESC
     LIMIT $${idx}`,
    params,
  );

  return result.rows.map((row) => ({
    ...row,
    matches: parseMatches(row.matched_rules_json),
  }));
}

function parseMatches(raw: string): LogMatch[] {
  try {
    const parsed = JSON.parse(raw) as LogMatch[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
