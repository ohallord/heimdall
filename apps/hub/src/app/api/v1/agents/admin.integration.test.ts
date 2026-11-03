import { beforeEach, describe, expect, it, vi } from "vitest";

const session: Record<string, unknown> = { save: vi.fn(async () => {}) };
// requireSession calls getSession internally, so mock the cookie layer beneath it.
vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("iron-session", () => ({ getIronSession: async () => session }));

import { getDb, resetDbForTests } from "@/lib/db/client";
import { createAgentToken, createOrgAndAdmin, registerAgentPersistent } from "@/lib/db/store";
import { authorizeAgentIngest } from "@/lib/agents/ingest-auth";
import { POST as revoke } from "./[agentId]/revoke/route";
import { POST as reenroll } from "./[agentId]/reenroll/route";
import { GET as listTokens, POST as createToken } from "./tokens/route";
import { DELETE as revokeToken } from "./tokens/[tokenId]/route";
import { GET as listAgents } from "./route";

const ctx = (agentId: string) => ({ params: Promise.resolve({ agentId }) });
const tctx = (tokenId: string) => ({ params: Promise.resolve({ tokenId }) });
const post = (body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://hub.test/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });
const ingestReq = (t: string) =>
  new Request("http://hub.test/i", { method: "POST", headers: { authorization: `Bearer ${t}` } });

let orgId: string;
let userId: string;
let token: string;
let agent: { id: string; secret: string };

function login(role: string, mfaVerified = true, org = orgId) {
  Object.assign(session, { isLoggedIn: true, userId, orgId: org, role, mfaVerified });
}

describe("agent admin APIs", () => {
  beforeEach(async () => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "test-token";
    delete process.env.DATABASE_URL;
    resetDbForTests();
    const { org, user } = await createOrgAndAdmin({
      orgName: "Ops", adminName: "A", email: "a@example.com", password: "CorrectHorse1",
    });
    orgId = org.id;
    userId = user.id;
    token = (await createAgentToken({ orgId, name: "t", createdBy: user.id })).token;
    const r = await registerAgentPersistent({ token, hostname: "h1", version: "1" });
    if (!r.ok) throw new Error("setup");
    agent = { id: r.agent.id, secret: r.agentSecret! };
    login("admin");
  });

  it("revoke: next ingest 401, list shows revoked; reenroll lets a new register mint a fresh secret", async () => {
    expect((await revoke(post(), ctx(agent.id))).status).toBe(200);
    expect(await authorizeAgentIngest(ingestReq(agent.secret), agent.id)).toMatchObject({ ok: false, status: 401 });
    const list = await (await listAgents()).json();
    expect(list.agents[0].revokedAt).toBeTruthy();

    expect((await reenroll(post(), ctx(agent.id))).status).toBe(200);
    const again = await registerAgentPersistent({ token, hostname: "h1", version: "2" });
    expect(again).toMatchObject({ ok: true });
    if (!again.ok) return;
    expect(again.agent.id).toBe(agent.id);
    expect(again.agentSecret).toBeTruthy();
    expect(again.agentSecret).not.toBe(agent.secret);
    expect(await authorizeAgentIngest(ingestReq(agent.secret), agent.id)).toMatchObject({ ok: false, status: 401 });
    expect((await authorizeAgentIngest(ingestReq(again.agentSecret!), agent.id)).ok).toBe(true);
  });

  it("RBAC: viewer is 403, operator allowed", async () => {
    login("viewer");
    expect((await revoke(post(), ctx(agent.id))).status).toBe(403);
    expect((await createToken(post({}))).status).toBe(403);
    login("operator");
    expect((await revoke(post(), ctx(agent.id))).status).toBe(200);
  });

  it("MFA: admin without verified MFA is 403 mfa_required", async () => {
    login("admin", false);
    const res = await revoke(post(), ctx(agent.id));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("mfa_required");
    expect((await createToken(post({}))).status).toBe(403);
  });

  it("CSRF: cross-origin POST/DELETE is 403 and changes nothing", async () => {
    const evil = { origin: "https://evil.example", host: "hub.test" };
    expect((await revoke(post({}, evil), ctx(agent.id))).status).toBe(403);
    expect((await reenroll(post({}, evil), ctx(agent.id))).status).toBe(403);
    expect((await createToken(post({}, evil))).status).toBe(403);
    expect(
      (await revokeToken(new Request("http://hub.test/x", { method: "DELETE", headers: evil }), tctx("x"))).status,
    ).toBe(403);
    expect((await authorizeAgentIngest(ingestReq(agent.secret), agent.id)).ok).toBe(true);
  });

  it("cross-org: another org's admin gets 404 and cannot revoke", async () => {
    const other = await createOrgAndAdmin({
      orgName: "Other", adminName: "B", email: "b@example.com", password: "CorrectHorse1",
    });
    login("admin", true, other.org.id);
    expect((await revoke(post(), ctx(agent.id))).status).toBe(404);
    expect((await reenroll(post(), ctx(agent.id))).status).toBe(404);
    expect((await authorizeAgentIngest(ingestReq(agent.secret), agent.id)).ok).toBe(true);
  });

  it("enrollment tokens: create (TTL + max uses), list hints only, revoke blocks register", async () => {
    const created = await createToken(post({ name: "lab", ttlHours: 1, maxUses: 2 }));
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.token).toMatch(/^hdt_/);
    expect(body.maxUses).toBe(2);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const listed = await (await listTokens()).json();
    const row = listed.tokens.find((t: { id: string }) => t.id === body.id);
    expect(row).toMatchObject({ name: "lab", maxUses: 2, useCount: 0 });
    expect(JSON.stringify(listed)).not.toContain(body.token);

    expect((await revokeToken(new Request("http://hub.test/x", { method: "DELETE" }), tctx(body.id))).status).toBe(200);
    expect(await registerAgentPersistent({ token: body.token, hostname: "h2", version: "1" })).toMatchObject({
      ok: false, status: 401,
    });
    const db = await getDb();
    expect((await db.query(`SELECT revoked_at FROM agent_tokens WHERE id=$1`, [body.id])).rows[0]).toMatchObject({
      revoked_at: expect.anything(),
    });
  });

  it("rejects invalid token payloads", async () => {
    expect((await createToken(post({ maxUses: -1 }))).status).toBe(400);
  });
});
