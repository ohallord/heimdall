import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as OTPAuth from "otpauth";

export function generateTotpSecret(email: string, issuer = "Heimdall"): {
  secret: string;
  uri: string;
} {
  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = new OTPAuth.TOTP({
    issuer,
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret,
  });
  return { secret: secret.base32, uri: totp.toString() };
}

export function verifyTotp(secret: string, token: string): boolean {
  return totpStep(secret, token) !== null;
}

/** The 30s time step the code belongs to (window ±1), or null if invalid. Used to block replay. */
export function totpStep(secret: string, token: string, now = Date.now()): number | null {
  const totp = new OTPAuth.TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  const delta = totp.validate({ token: token.replace(/\s+/g, ""), window: 1, timestamp: now });
  if (delta === null) return null;
  return Math.floor(now / 30_000) + delta;
}

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () =>
    randomBytes(5).toString("hex").toUpperCase(),
  );
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
