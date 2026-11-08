import { beforeEach, describe, expect, it, vi } from "vitest";

const session: Record<string, unknown> = { save: vi.fn(async () => {}) };
vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("iron-session", () => ({ getIronSession: async () => session }));

import { resetDbForTests } from "@/lib/db/client";
import { resetBootstrapCache } from "@/lib/agents/bootstrap";
import { resetRateLimits } from "@/lib/http-guard/rate-limit";
import { createOrgAndAdmin, isSetupComplete, markSetupComplete } from "@/lib/db/store";
import { POST as orgAdmin } from "./org-admin/route";
import { POST as agentToken } from "./agent-token/route";
import { POST as channels } from "./channels/route";
import { POST as remotes } from "./remotes/route";

const TOKEN = "bootstrap-token-for-setup-tests-0123456789";
const admin = (extra: Record<string, unknown> = {}) => ({
  orgName: "Ops", adminName: "Ada", email: "ada@example.com", password: "Correct-Horse-Battery-9", ...extra,
});
const post = (body: unknown) =>
  new Request("http://hub.test/api/v1/setup/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("first-run setup cannot be claimed or re-opened by strangers", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = TOKEN;
    delete process.env.DATABASE_URL;
    resetDbForTests();
    resetBootstrapCache();
    resetRateLimits();
    for (const k of Object.keys(session)) if (k !== "save") delete session[k];
  });

  it("refuses to create the first admin without the bootstrap token", async () => {
    expect((await orgAdmin(post(admin()))).status).toBe(400);
    expect((await orgAdmin(post(admin({ setupToken: "guess" })))).status).toBe(403);
    expect((await orgAdmin(post(admin({ setupToken: TOKEN })))).status).toBe(200);
  });

  it("allows exactly one first admin, even before setup completes and under a race", async () => {
    const results = await Promise.all([
      orgAdmin(post(admin({ setupToken: TOKEN }))),
      orgAdmin(post(admin({ setupToken: TOKEN, email: "eve@example.com" }))),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await orgAdmin(post(admin({ setupToken: TOKEN, email: "mallory@example.com" })))).status).toBe(409);
  });

  it("wizard routes refuse after setup is complete and never flip it back", async () => {
    const { org, user } = await createOrgAndAdmin({
      orgName: "Ops", adminName: "A", email: "a@example.com", password: "Correct-Horse-Battery-9",
    });
    await markSetupComplete(org.id);
    // Password-only admin session (MFA enrolled but not yet verified).
    Object.assign(session, { isLoggedIn: true, userId: user.id, orgId: org.id, role: "admin", mfaVerified: false });
    expect((await agentToken(post({}))).status).toBe(409);
    expect((await channels(post({}))).status).toBe(409);
    expect((await remotes(post({}))).status).toBe(409);
    expect(await isSetupComplete()).toBe(true);
    expect((await orgAdmin(post(admin({ setupToken: TOKEN, email: "x@example.com" })))).status).toBe(409);
  });
});
