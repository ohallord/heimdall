import { beforeEach, describe, expect, it, vi } from "vitest";

const session = { save: vi.fn(async () => {}) } as Record<string, unknown>;
vi.mock("@/lib/auth/session", () => ({ getSession: async () => session }));
const { verifyPassword } = vi.hoisted(() => ({ verifyPassword: vi.fn(async (pw: string) => pw === "right") }));
vi.mock("@/lib/auth/password", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/password")>()),
  verifyPassword,
  hashPassword: async () => "h",
}));
vi.mock("@/lib/db/store", () => ({
  findUserByEmail: async (e: string) =>
    e === "ada@example.com"
      ? { id: "u1", org_id: "o1", email: e, role: "member", mfa_enrolled: false, password_hash: "h" }
      : null,
}));

import { resetRateLimits } from "@/lib/http-guard/rate-limit";
import { POST } from "./route";

const req = (email: string, password: string) =>
  new Request("http://hub.test/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

describe("login rate limit", () => {
  beforeEach(() => {
    resetRateLimits();
    process.env.HEIMDALL_RATE_LOGIN = "3/60";
  });

  it("429s after N failures, even for the right password", async () => {
    for (let i = 0; i < 3; i++) expect((await POST(req("ada@example.com", "bad"))).status).toBe(401);
    const res = await POST(req("ada@example.com", "right"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("counts per email: another account is unaffected", async () => {
    for (let i = 0; i < 3; i++) await POST(req("nobody@example.com", "bad"));
    expect((await POST(req("nobody@example.com", "bad"))).status).toBe(429);
    expect((await POST(req("ada@example.com", "right"))).status).toBe(200);
  });

  it("success clears the failure count", async () => {
    for (let i = 0; i < 2; i++) await POST(req("ada@example.com", "bad"));
    expect((await POST(req("ada@example.com", "right"))).status).toBe(200);
    for (let i = 0; i < 2; i++) expect((await POST(req("ada@example.com", "bad"))).status).toBe(401);
    expect((await POST(req("ada@example.com", "right"))).status).toBe(200);
  });
});
