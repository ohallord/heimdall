export type RateName = "LOGIN" | "MFA" | "INGEST" | "REGISTER" | "WEBHOOK";

const DEFAULTS: Record<RateName, { max: number; windowMs: number }> = {
  LOGIN: { max: 10, windowMs: 15 * 60_000 },
  MFA: { max: 5, windowMs: 5 * 60_000 },
  INGEST: { max: 600, windowMs: 60_000 },
  REGISTER: { max: 30, windowMs: 60_000 },
  WEBHOOK: { max: 120, windowMs: 60_000 },
};

/** Preset with optional `HEIMDALL_RATE_<NAME>=max/windowSec` override. */
export function presetFor(name: RateName): { max: number; windowMs: number } {
  const m = /^(\d+)\/(\d+)$/.exec(process.env[`HEIMDALL_RATE_${name}`] ?? "");
  if (m && Number(m[1]) > 0 && Number(m[2]) > 0) {
    return { max: Number(m[1]), windowMs: Number(m[2]) * 1000 };
  }
  return DEFAULTS[name];
}

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
/** Hard cap so a flood of distinct keys (random tokens) cannot grow memory without bound. */
const MAX_BUCKETS = 50_000;
let lastSweep = 0;

export function bucketCount(): number {
  return buckets.size;
}

export function resetRateLimits(): void {
  buckets.clear();
  lastSweep = 0;
}

export function limit(o: { key: string; max: number; windowMs: number }): {
  allowed: boolean;
  retryAfter: number;
  remaining: number;
} {
  const now = Date.now();
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
  let b = buckets.get(o.key);
  if (!b || b.resetAt <= now) {
    if (!b && buckets.size >= MAX_BUCKETS) {
      // Evict the oldest entries (Map keeps insertion order).
      const drop = Math.ceil(MAX_BUCKETS / 10);
      let i = 0;
      for (const k of buckets.keys()) {
        if (i++ >= drop) break;
        buckets.delete(k);
      }
    }
    b = { count: 0, resetAt: now + o.windowMs };
    buckets.set(o.key, b);
  }
  b.count++;
  const allowed = b.count <= o.max;
  return {
    allowed,
    retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
    remaining: Math.max(0, o.max - b.count),
  };
}

/** Client IP. X-Forwarded-For is honored only when HEIMDALL_TRUST_PROXY is set (N trusted hops; true = 1). */
export function clientIp(request: Request): string {
  const t = process.env.HEIMDALL_TRUST_PROXY;
  if (!t || t === "0" || t === "false") return "unknown";
  const hops = t === "true" ? 1 : Math.max(1, parseInt(t, 10) || 1);
  const xff = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (xff.length === 0) return "unknown";
  return xff[Math.max(0, xff.length - hops)];
}

export function tooMany(retryAfter: number): Response {
  return new Response(JSON.stringify({ error: "rate_limited" }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": String(retryAfter) },
  });
}

/** True if the key has already used up its budget (does not count a hit). */
export function isBlocked(o: { key: string; max: number }): { blocked: boolean; retryAfter: number } {
  const b = buckets.get(o.key);
  const now = Date.now();
  if (!b || b.resetAt <= now || b.count < o.max) return { blocked: false, retryAfter: 0 };
  return { blocked: true, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
}

export function clearLimit(key: string): void {
  buckets.delete(key);
}
