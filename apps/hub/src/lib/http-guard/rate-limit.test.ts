import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientIp, limit, presetFor, resetRateLimits, tooMany } from "./rate-limit";

beforeEach(() => {
  vi.useFakeTimers();
  resetRateLimits();
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.HEIMDALL_TRUST_PROXY;
  delete process.env.HEIMDALL_RATE_LOGIN;
});

describe("limit", () => {
  it("allows up to max then blocks with retryAfter", () => {
    for (let i = 0; i < 3; i++) expect(limit({ key: "k", max: 3, windowMs: 1000 }).allowed).toBe(true);
    const r = limit({ key: "k", max: 3, windowMs: 1000 });
    expect(r.allowed).toBe(false);
    expect(r.retryAfter).toBeGreaterThanOrEqual(1);
  });
  it("resets after window", () => {
    for (let i = 0; i < 4; i++) limit({ key: "k", max: 3, windowMs: 1000 });
    vi.advanceTimersByTime(1001);
    expect(limit({ key: "k", max: 3, windowMs: 1000 }).allowed).toBe(true);
  });
  it("isolates keys", () => {
    for (let i = 0; i < 4; i++) limit({ key: "a", max: 3, windowMs: 1000 });
    expect(limit({ key: "b", max: 3, windowMs: 1000 }).allowed).toBe(true);
  });
});

describe("presets", () => {
  it("has defaults", () => {
    expect(presetFor("LOGIN")).toEqual({ max: 10, windowMs: 15 * 60_000 });
    expect(presetFor("MFA")).toEqual({ max: 5, windowMs: 5 * 60_000 });
  });
  it("env override max/windowSec", () => {
    process.env.HEIMDALL_RATE_LOGIN = "3/60";
    expect(presetFor("LOGIN")).toEqual({ max: 3, windowMs: 60_000 });
  });
  it("ignores malformed override", () => {
    process.env.HEIMDALL_RATE_LOGIN = "junk";
    expect(presetFor("LOGIN").max).toBe(10);
  });
});

describe("clientIp", () => {
  const r = (h: Record<string, string>) => new Request("http://x/", { headers: h });
  it("ignores XFF when proxy not trusted", () => {
    expect(clientIp(r({ "x-forwarded-for": "1.1.1.1" }))).toBe("unknown");
  });
  it("uses right-most hop when trusted (1 hop)", () => {
    process.env.HEIMDALL_TRUST_PROXY = "1";
    expect(clientIp(r({ "x-forwarded-for": "6.6.6.6, 2.2.2.2" }))).toBe("2.2.2.2");
  });
  it("supports N trusted hops", () => {
    process.env.HEIMDALL_TRUST_PROXY = "2";
    expect(clientIp(r({ "x-forwarded-for": "6.6.6.6, 2.2.2.2, 3.3.3.3" }))).toBe("2.2.2.2");
  });
  it("true means 1 hop", () => {
    process.env.HEIMDALL_TRUST_PROXY = "true";
    expect(clientIp(r({ "x-forwarded-for": "9.9.9.9" }))).toBe("9.9.9.9");
  });
});

describe("tooMany", () => {
  it("returns 429 with Retry-After", () => {
    const res = tooMany(7);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
  });
});

describe("bucket map is bounded", () => {
  it("evicts old buckets instead of growing without limit", async () => {
    const { bucketCount, limit, resetRateLimits } = await import("./rate-limit");
    resetRateLimits();
    for (let i = 0; i < 60_000; i++) limit({ key: `random-token-${i}`, max: 5, windowMs: 60_000 });
    expect(bucketCount()).toBeLessThanOrEqual(50_000);
  });
});
