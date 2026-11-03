/** In-process WebAuthn challenge store (single node only). */
const challenges = new Map<string, string>();

export function putChallenge(userId: string, challenge: string) {
  challenges.set(userId, challenge);
}

export function takeChallenge(userId: string): string | undefined {
  const value = challenges.get(userId);
  challenges.delete(userId);
  return value;
}
