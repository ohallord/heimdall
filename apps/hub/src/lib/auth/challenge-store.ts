/** In-process WebAuthn challenge store (single-node). Challenges expire after 5 minutes. */
const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 10_000;
const challenges = new Map<string, { value: string; expiresAt: number }>();

export function putChallenge(userId: string, challenge: string, now = Date.now()) {
  if (challenges.size >= MAX_ENTRIES) {
    for (const [k, v] of challenges) if (v.expiresAt <= now) challenges.delete(k);
    const oldest = challenges.keys().next();
    if (challenges.size >= MAX_ENTRIES && !oldest.done) challenges.delete(oldest.value);
  }
  challenges.set(userId, { value: challenge, expiresAt: now + TTL_MS });
}

export function takeChallenge(userId: string, now = Date.now()): string | undefined {
  const entry = challenges.get(userId);
  challenges.delete(userId);
  if (!entry || entry.expiresAt <= now) return undefined;
  return entry.value;
}
