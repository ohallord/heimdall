/**
 * Sustain window: a threshold breach must last N seconds before it opens an alert, so a spike that
 * goes red and green within a minute never notifies. In-process like the cooldown: a hub restart
 * only restarts the clock (the alert is delayed, never lost or duplicated).
 */

type Breach = { since: number; lastSeen: number };

const breaches = new Map<string, Breach>();

/** Samples missing for longer than this (agent offline, rule disabled) restart the clock. */
export const SUSTAIN_STALE_MS = 5 * 60 * 1000;

/** Record that `key` (an alert fingerprint) is breaching at `now`. */
export function markBreach(key: string, now = Date.now()): void {
  const prev = breaches.get(key);
  if (prev && now - prev.lastSeen <= SUSTAIN_STALE_MS) {
    prev.lastSeen = now;
    return;
  }
  breaches.set(key, { since: now, lastSeen: now });
}

/** A healthy sample ends the breach and resets the clock. */
export function clearBreach(key: string): void {
  breaches.delete(key);
}

/** True when `key` has been breaching continuously for at least `sustainMs`. */
export function breachSustained(key: string, now: number, sustainMs: number): boolean {
  const b = breaches.get(key);
  if (!b) return false;
  return now - b.since >= sustainMs;
}

/** Test helper. */
export function resetSustainState(): void {
  breaches.clear();
}
