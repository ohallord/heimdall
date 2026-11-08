import { beforeEach, describe, expect, it, vi } from "vitest";

// One shared fake cookie jar; getSession re-validates it against the DB.
const jar: Record<string, unknown> = {};
const session: Record<string, unknown> = {
  save: vi.fn(async () => {}),
  destroy: vi.fn(() => {
    for (const k of Object.keys(jar)) delete jar[k];
  }),
};
vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("iron-session", () => ({ getIronSession: async () => Object.assign(session, jar) }));

import { resetDbForTests, getDb } from "@/lib/db/client";
import { createOrgAndAdmin } from "@/lib/db/store";
import { requireSession } from "./session";
import { POST as logout } from "@/app/api/v1/auth/logout/route";

let userId: string;
let orgId: string;

function signIn(extra: Record<string, unknown> = {}) {
  for (const k of Object.keys(jar)) delete jar[k];
  Object.assign(jar, { isLoggedIn: true, userId, orgId, role: "admin", mfaVerified: true, sessionVersion: 0, ...extra });
  for (const k of ["isLoggedIn", "userId", "orgId", "role", "mfaVerified", "sessionVersion"]) session[k] = jar[k];
}

describe("server-side session revocation", () => {
  beforeEach(async () => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    delete process.env.DATABASE_URL;
    resetDbForTests();
    const { org, user } = await createOrgAndAdmin({
      orgName: "Ops", adminName: "A", email: "a@example.com", password: "CorrectHorse1",
    });
    userId = user.id;
    orgId = org.id;
  });

  it("logout invalidates a copied cookie", async () => {
    signIn();
    const stolen = { ...jar };
    await expect(requireSession()).resolves.toBeTruthy();
    const res = await logout(new Request("http://hub.test/api/v1/auth/logout", { method: "POST" }));
    expect(res.status).toBe(200);
    signIn(stolen); // attacker replays the cookie captured before logout
    await expect(requireSession()).rejects.toMatchObject({ status: 401 });
  });

  it("a deleted user's cookie stops working", async () => {
    signIn();
    await (await getDb()).query(`DELETE FROM users WHERE id = $1`, [userId]);
    await expect(requireSession()).rejects.toMatchObject({ status: 401 });
  });

  it("a demotion takes effect without waiting for the cookie to expire", async () => {
    signIn();
    await (await getDb()).query(`UPDATE users SET role = 'viewer' WHERE id = $1`, [userId]);
    await expect(requireSession({ permission: "settings:write" })).rejects.toMatchObject({ status: 403 });
  });
});
