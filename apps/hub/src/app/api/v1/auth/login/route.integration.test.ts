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
import { createOrgAndAdmin } from "@/lib/db/store";
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
});
