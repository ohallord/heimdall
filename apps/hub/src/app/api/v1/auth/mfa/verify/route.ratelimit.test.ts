import { beforeEach, describe, expect, it, vi } from "vitest";

const session = { isLoggedIn: true, userId: "u1", save: vi.fn(async () => {}) } as Record<string, unknown>;
vi.mock("@/lib/auth/session", () => ({ getSession: async () => session }));
vi.mock("@/lib/db/store", () => ({
  findUserById: async (id: string) => ({ id, totp_secret: "s" }),
  consumeRecoveryCode: async (_u: string, c: string) => c === "good-recovery",
  claimTotpStep: async (u: string, step: number) => {
    const last = usedSteps.get(u) ?? -1;
    if (step <= last) return false;
    usedSteps.set(u, step);
    return true;
  },
}));
const usedSteps = new Map<string, number>();
let step = 1000;
vi.mock("@/lib/mfa/totp", () => ({ totpStep: (_s: string, c: string) => (c === "123456" ? step : null) }));

import { resetRateLimits } from "@/lib/http-guard/rate-limit";
import { POST } from "./route";

const req = (method: string, code: string) =>
  new Request("http://hub.test/api/v1/auth/mfa/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, code }),
  });

describe("mfa verify rate limit", () => {
  beforeEach(() => {
    resetRateLimits();
    usedSteps.clear();
    step += 10;
    session.userId = "u1";
    session.mfaVerified = false;
    process.env.HEIMDALL_RATE_MFA = "3/60";
  });

  it("429s after N bad codes, even with a correct one", async () => {
    for (let i = 0; i < 3; i++) expect((await POST(req("totp", "000000"))).status).toBe(401);
    const res = await POST(req("totp", "123456"));
    expect(res.status).toBe(429);
    expect(session.mfaVerified).toBe(false);
  });

  it("limits recovery codes on the same budget", async () => {
    for (let i = 0; i < 3; i++) await POST(req("recovery", "nope"));
    expect((await POST(req("recovery", "good-recovery"))).status).toBe(429);
  });

  it("is keyed per user and cleared on success", async () => {
    for (let i = 0; i < 2; i++) await POST(req("totp", "000000"));
    expect((await POST(req("totp", "123456"))).status).toBe(200);
    for (let i = 0; i < 2; i++) expect((await POST(req("totp", "000000"))).status).toBe(401);
    session.userId = "u2";
    expect((await POST(req("totp", "123456"))).status).toBe(200);
  });

  it("counts parallel guesses: a burst cannot exceed the budget", async () => {
    const statuses = (await Promise.all(Array.from({ length: 20 }, () => POST(req("totp", "000000"))))).map(
      (r) => r.status,
    );
    expect(statuses.filter((s) => s === 401)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(17);
  });

  it("rejects a replayed TOTP code (same time step)", async () => {
    expect((await POST(req("totp", "123456"))).status).toBe(200);
    expect((await POST(req("totp", "123456"))).status).toBe(401);
  });
});
