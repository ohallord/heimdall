import { createHash, timingSafeEqual } from "node:crypto";

/** Constant-time string equality. Hashes both sides so length never leaks. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}
