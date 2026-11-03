import { createHash } from "node:crypto";

/** Stable mute/dedupe key for an alert identity within an org. */
export function alertFingerprint(parts: {
  orgId: string;
  ruleOrSource: string;
  agentOrAlarmId: string;
  metricOrName: string;
}): string {
  const raw = [
    parts.orgId,
    parts.ruleOrSource,
    parts.agentOrAlarmId,
    parts.metricOrName,
  ].join("|");
  return createHash("sha256").update(raw).digest("hex");
}

export const MUTE_PRESETS_MINUTES = [15, 30, 60, 240] as const;
export type MutePresetMinutes = (typeof MUTE_PRESETS_MINUTES)[number];

export function isMutePreset(n: number): n is MutePresetMinutes {
  return (MUTE_PRESETS_MINUTES as readonly number[]).includes(n);
}
