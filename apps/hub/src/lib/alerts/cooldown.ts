/** In-process cooldown so the same rule/agent/metric does not spam every scrape. */

const lastFiredAt = new Map<string, number>();

/** Default 15m — lab Compose scrapes every ~10s; keep notifications rare. */
export const DEFAULT_ALERT_COOLDOWN_MS = 15 * 60 * 1000;

export function alertCooldownKey(parts: {
  orgId: string;
  ruleId: string;
  agentId?: string;
  metric: string;
}): string {
  return [
    parts.orgId,
    parts.ruleId,
    parts.agentId ?? "-",
    parts.metric,
  ].join(":");
}

export function shouldFireAlert(
  key: string,
  now = Date.now(),
  cooldownMs = DEFAULT_ALERT_COOLDOWN_MS,
): boolean {
  const prev = lastFiredAt.get(key);
  if (prev != null && now - prev < cooldownMs) {
    return false;
  }
  lastFiredAt.set(key, now);
  return true;
}

/** Test helper — clears cooldown state between cases. */
export function resetAlertCooldowns(): void {
  lastFiredAt.clear();
}
