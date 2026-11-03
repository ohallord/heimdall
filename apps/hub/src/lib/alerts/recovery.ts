import type { AlertRuleRow } from "@/lib/db/types";
import type { ResolvedAlertEvent } from "@/lib/db/store";
import type { AlertPayload } from "./channels";
import { effectiveAlarm, type ThresholdSample } from "./engine";
import {
  alertDeepLink,
  formatDuration,
  formatMetricValue,
  formatThreshold,
  formatTimestamp,
  metricLabel,
} from "./format";

/**
 * Turn auto-resolved alert events into "Recovered" notifications.
 *
 * - Only alerts that actually notified someone get a recovery: yellow-band
 *   (warn-only, history-only) and muted alerts stay quiet.
 * - One notification per alert identity (fingerprint): cooldown can leave
 *   several open events for the same breach; the newest is linked, the
 *   oldest gives the duration.
 * - Severity "info", so quiet hours suppress recoveries; the alarm console
 *   still shows the alert as recovered.
 */
export function buildRecoveryPayloads(input: {
  resolved: ResolvedAlertEvent[];
  rules: Pick<AlertRuleRow, "id" | "name" | "operator" | "threshold" | "alarm_threshold">[];
  hostname: string;
  samples: ThresholdSample[];
  now?: Date;
}): AlertPayload[] {
  const now = input.now ?? new Date();
  const groups = new Map<string, ResolvedAlertEvent[]>();
  for (const ev of input.resolved) {
    if (ev.previousStatus !== "open") continue;
    if (ev.payload.band === "yellow") continue;
    const list = groups.get(ev.fingerprint) ?? [];
    list.push(ev);
    groups.set(ev.fingerprint, list);
  }

  const payloads: AlertPayload[] = [];
  for (const events of groups.values()) {
    events.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const first = events[0];
    const latest = events[events.length - 1];
    const rule = input.rules.find((r) => r.id === latest.ruleId);
    const metric = latest.payload.sample?.metric ?? "";
    const hostname = latest.payload.hostname ?? input.hostname;
    const ruleName = rule?.name ?? metricLabel(metric);
    const startedAt = new Date(first.createdAt);
    const duration = formatDuration(now.getTime() - startedAt.getTime());

    const current = input.samples.find((s) => s.metric === metric);
    const isMount = metric.startsWith("mount_missing:");
    const isContainer = metric.startsWith("container_exited:");
    const fields: { label: string; value: string }[] = [
      { label: "Host", value: hostname },
      { label: "Metric", value: metricLabel(metric) },
    ];
    if (current && !isMount && !isContainer) {
      fields.push({ label: "Now", value: formatMetricValue(metric, current.value) });
    }
    if (rule && !isMount && !isContainer) {
      fields.push({
        label: "Alarm threshold",
        value: formatThreshold(rule.operator, effectiveAlarm(rule), metric),
      });
    }
    fields.push(
      { label: "Started", value: formatTimestamp(startedAt) },
      { label: "Recovered", value: formatTimestamp(now) },
      { label: "Duration", value: duration },
    );

    const message = isMount
      ? `Mount ${metric.slice("mount_missing:".length)} is back after ${duration}.`
      : isContainer
        ? `Container ${metric.slice("container_exited:".length)} is no longer exited (running again or removed) after ${duration}.`
        : current
        ? `${metricLabel(metric)} is back to normal at ${formatMetricValue(metric, current.value)} after ${duration}.`
        : `${metricLabel(metric)} is back to normal after ${duration}.`;

    payloads.push({
      kind: "recovery",
      severity: "info",
      subject: `${ruleName} on ${hostname}`,
      message,
      hostname,
      deepLink: alertDeepLink(latest.id),
      fields,
    });
  }
  return payloads;
}
