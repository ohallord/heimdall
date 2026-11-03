import { createChannel, type AlertPayload, type ChannelSendResult } from "./channels";
import { areAlertsPaused } from "./pause";
import {
  shouldSuppressForQuietHours,
  type AlertSeverity,
} from "./quiet-hours";
import { bandFor, type StatusBand } from "./bands";
import type {
  AlertChannelKind,
  AlertChannelRow,
  AlertRuleRow,
  NotificationPrefsRow,
} from "@/lib/db/types";

export type ThresholdSample = {
  metric: string;
  value: number;
};

export function ruleMatchesMetric(ruleMetric: string, sampleMetric: string): boolean {
  // Mount missing alerts once per path (mount_missing:<path>) so the notification
  // names the mount; the bare mount_missing sample is a host aggregate for charts.
  if (ruleMetric === "mount_missing") return sampleMetric.startsWith("mount_missing:");
  // Same for container exits: one alert per container (container_exited:<name>).
  if (ruleMetric === "container_exited") {
    return sampleMetric.startsWith("container_exited:");
  }
  if (ruleMetric === sampleMetric) return true;
  // One High disk rule covers root + every reported mount.
  if (ruleMetric === "disk_percent" && sampleMetric.startsWith("disk_percent:")) {
    return true;
  }
  return false;
}

export function effectiveAlarm(
  rule: Pick<AlertRuleRow, "threshold" | "alarm_threshold">,
): number {
  if (rule.alarm_threshold != null && Number.isFinite(Number(rule.alarm_threshold))) {
    return Number(rule.alarm_threshold);
  }
  return Number(rule.threshold);
}

export function effectiveWarn(
  rule: Pick<AlertRuleRow, "warn_threshold">,
): number | null {
  if (rule.warn_threshold == null) return null;
  const n = Number(rule.warn_threshold);
  return Number.isFinite(n) ? n : null;
}

function compareOp(
  operator: AlertRuleRow["operator"],
  value: number,
  threshold: number,
): boolean {
  switch (operator) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
    case "eq":
      return value === threshold;
    default:
      return false;
  }
}

export function evaluateRule(
  rule: Pick<
    AlertRuleRow,
    "metric" | "operator" | "threshold" | "warn_threshold" | "alarm_threshold" | "enabled"
  >,
  sample: ThresholdSample,
): boolean {
  if (!rule.enabled) return false;
  if (!ruleMatchesMetric(rule.metric, sample.metric)) return false;
  return compareOp(rule.operator, sample.value, effectiveAlarm(rule));
}

/**
 * Dual-band evaluation for host utilization rules (gte/gt).
 * Returns null when the rule has no warn band (binary / legacy).
 */
export function evaluateRuleBand(
  rule: Pick<
    AlertRuleRow,
    "metric" | "operator" | "threshold" | "warn_threshold" | "alarm_threshold" | "enabled"
  >,
  sample: ThresholdSample,
): StatusBand | null {
  if (!rule.enabled) return null;
  if (!ruleMatchesMetric(rule.metric, sample.metric)) return null;
  const warn = effectiveWarn(rule);
  if (warn == null) return null;
  if (rule.operator !== "gte" && rule.operator !== "gt") return null;
  return bandFor(sample.value, warn, effectiveAlarm(rule));
}

function kindNotifyFlag(
  prefs: NotificationPrefsRow,
  kind: AlertChannelKind,
): boolean {
  switch (kind) {
    case "smtp":
      return prefs.notify_smtp;
    case "slack":
      return prefs.notify_slack;
    case "discord":
      return prefs.notify_discord;
    case "sms":
      return prefs.notify_sms;
    default:
      return true;
  }
}

/** True when at least one user wants this channel (or no prefs exist → allow). */
export function channelWantedByUsers(
  kind: AlertChannelKind,
  prefsList: NotificationPrefsRow[],
): boolean {
  if (prefsList.length === 0) return true;
  return prefsList.some((p) => kindNotifyFlag(p, kind));
}

export type DispatchOptions = {
  prefs?: NotificationPrefsRow[];
  now?: Date;
};

export async function dispatchAlert(
  channels: AlertChannelRow[],
  payload: AlertPayload,
  options: DispatchOptions = {},
): Promise<ChannelSendResult[]> {
  if (areAlertsPaused()) {
    return [
      {
        ok: true,
        channel: "paused",
        detail: "HEIMDALL_ALERTS_PAUSED or admin pause",
      },
    ];
  }

  const prefs = options.prefs ?? [];
  const severity = (payload.severity ?? "warning") as AlertSeverity;
  const now = options.now ?? new Date();

  if (
    shouldSuppressForQuietHours(
      prefs.map((p) => ({
        enabled: p.quiet_hours_enabled,
        start: p.quiet_start,
        end: p.quiet_end,
        timezone: p.timezone,
      })),
      severity,
      now,
    )
  ) {
    return [
      {
        ok: true,
        channel: "quiet_hours",
        detail: "suppressed during quiet hours",
      },
    ];
  }

  const results: ChannelSendResult[] = [];
  for (const row of channels) {
    if (!row.enabled) continue;
    if (!channelWantedByUsers(row.kind, prefs)) {
      results.push({
        ok: true,
        channel: row.kind,
        detail: "skipped by user notification preferences",
      });
      continue;
    }

    const config = JSON.parse(row.config_json) as Record<string, unknown>;

    // Prefer a user-provided SMS phone when the org SMS "to" is empty.
    if (row.kind === "sms") {
      const to = typeof config.to === "string" ? config.to.trim() : "";
      if (!to) {
        const phone = prefs.find((p) => p.notify_sms && p.sms_phone)?.sms_phone;
        if (phone) config.to = phone;
      }
    }

    const channel = createChannel(row.kind, config);
    try {
      results.push(await channel.send(payload));
    } catch (err) {
      results.push({
        ok: false,
        channel: row.kind,
        detail: err instanceof Error ? err.message : "send failed",
      });
    }
  }
  return results;
}
