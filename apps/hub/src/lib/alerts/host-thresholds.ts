import type { AlertRuleRow } from "@/lib/db/types";
import { bandFor, type StatusBand } from "./bands";
import { effectiveAlarm, effectiveWarn } from "./engine";

export function findHostRule(
  rules: AlertRuleRow[],
  metric: "cpu_percent" | "mem_percent" | "disk_percent",
): AlertRuleRow | undefined {
  return rules.find((r) => r.metric === metric);
}

export function bandForHostMetric(
  value: number | null | undefined,
  rule: AlertRuleRow | undefined,
  fallbackWarn: number,
  fallbackAlarm: number,
): StatusBand {
  if (value == null || !Number.isFinite(Number(value))) return "green";
  const warn = rule ? (effectiveWarn(rule) ?? fallbackWarn) : fallbackWarn;
  const alarm = rule ? effectiveAlarm(rule) : fallbackAlarm;
  return bandFor(Number(value), warn, alarm);
}
