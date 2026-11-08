import { beforeEach, describe, expect, it, vi } from "vitest";

const session = { save: vi.fn(async () => {}) } as Record<string, unknown>;
vi.mock("@/lib/auth/session", () => ({ getSession: async () => session }));

const { verifyPassword } = vi.hoisted(() => ({
  verifyPassword: vi.fn(async () => false),
}));
vi.mock("@/lib/auth/password", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/password")>()),
  verifyPassword,
}));

import { resetDbForTests } from "@/lib/db/client";
import { createOrgAndAdmin, createUser } from "@/lib/db/store";
import { POST } from "./route";

const req = (email: string, password: string) =>
  new Request("http://hub.test/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

describe("login unknown-user timing", () => {
  beforeEach(async () => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    delete process.env.DATABASE_URL;
    resetDbForTests();
    verifyPassword.mockClear();
    await createOrgAndAdmin({
      orgName: "Org",
      adminName: "Ada",
      email: "ada@example.com",
      password: "CorrectHorse1",
    });
  });

  it("runs a dummy bcrypt compare for unknown email, same 401 body as wrong password", async () => {
    const unknown = await POST(req("nobody@example.com", "whatever1234"));
    expect(verifyPassword).toHaveBeenCalledTimes(1);
    const wrong = await POST(req("ada@example.com", "whatever1234"));
    expect(verifyPassword).toHaveBeenCalledTimes(2);
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await unknown.json()).toEqual(await wrong.json());
  });

  it("accepts the username admin when that is the stored account", async () => {
    await createOrgAndAdmin({
      orgName: "Lab",
      adminName: "Dan",
      email: "admin",
      password: "CorrectHorse1",
    });
    verifyPassword.mockResolvedValueOnce(true);
    const res = await POST(req("admin", "CorrectHorse1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.email).toBe("admin");
  });

  it("accepts the display name when the account has a separate email", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "Lab",
      adminName: "Owner",
      email: "owner@example.com",
      password: "CorrectHorse1",
    });
    await createUser({
      orgId: org.id,
      email: "ops@example.com",
      name: "admin",
      password: "CorrectHorse1",
      role: "admin",
    });
    verifyPassword.mockResolvedValueOnce(true);
    const res = await POST(req("Admin", "CorrectHorse1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.email).toBe("ops@example.com");
  });

  it("rejects a login id that is neither an email nor a username", async () => {
    const res = await POST(req("not a user", "whatever1234"));
    expect(res.status).toBe(400);
  });
});
