import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDbForTests } from "@/lib/db/client";
import {
  createAgentToken,
  createOrgAndAdmin,
  registerAgentPersistent,
} from "@/lib/db/store";
import { authorizeAgentIngest } from "./ingest-auth";

const req = (token?: string) =>
  new Request("http://hub.local/api/v1/agents/metrics", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

async function setup() {
  const { org, user } = await createOrgAndAdmin({
    orgName: "Ops",
    adminName: "Admin",
    email: "ops@example.com",
    password: "CorrectHorse1",
  });
  const { token, row } = await createAgentToken({ orgId: org.id, name: "fleet", createdBy: user.id });
  return { org, user, token, tokenId: row.id };
}

type Minted = { agent: { id: string }; agentSecret?: string };
async function reg(token: string, hostname: string, agentSecret?: string) {
  return registerAgentPersistent({ token, hostname, version: "1", agentSecret }) as Promise<
    ({ ok: true } & Minted) | { ok: false; error: string; status: number }
  >;
}

describe("per-agent credentials", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "test-token";
    delete process.env.HEIMDALL_LEGACY_TOKENS;
    delete process.env.DATABASE_URL;
    resetDbForTests();
  });

  it("register mints an hda_ secret, stored only as a hash", async () => {
    const { token } = await setup();
    const r = await reg(token, "edge-01");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agentSecret).toMatch(/^hda_[A-Za-z0-9_-]{43}$/);
    const db = await getDb();
    const row = (await db.query<{ secret_hash: string }>(`SELECT secret_hash FROM agents WHERE id=$1`, [r.agent.id])).rows[0];
    expect(row.secret_hash).toBeTruthy();
    expect(row.secret_hash).not.toContain(r.agentSecret!);
  });

  it("hostname rebind: a second host with only the enrollment token gets 409 hostname_in_use", async () => {
    const { token } = await setup();
    expect((await reg(token, "edge-01")).ok).toBe(true);
    const again = await reg(token, "edge-01");
    expect(again).toMatchObject({ ok: false, status: 409, error: "hostname_in_use" });
    const wrong = await reg(token, "edge-01", "hda_wrong");
    expect(wrong).toMatchObject({ ok: false, status: 409 });
  });

  it("re-register with the agent's own secret succeeds and does not rotate it", async () => {
    const { token } = await setup();
    const first = await reg(token, "edge-01");
    if (!first.ok) throw new Error("setup");
    const again = await reg(token, "edge-01", first.agentSecret);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.agent.id).toBe(first.agent.id);
    expect(again.agentSecret).toBeUndefined();
  });

  it("legacy row without a secret is adopted and upgraded on next register", async () => {
    const { token, org } = await setup();
    const db = await getDb();
    await db.query(`INSERT INTO agents (id, org_id, hostname, version) VALUES ('agt_old', $1, 'old-host', '0')`, [org.id]);
    const r = await reg(token, "old-host");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agent.id).toBe("agt_old");
    expect(r.agentSecret).toMatch(/^hda_/);
  });

  it("enrollment tokens: expired and exhausted tokens are rejected", async () => {
    const { token, tokenId } = await setup();
    const db = await getDb();
    await db.query(`UPDATE agent_tokens SET max_uses = 1 WHERE id=$1`, [tokenId]);
    expect((await reg(token, "a")).ok).toBe(true);
    expect(await reg(token, "b")).toMatchObject({ ok: false, status: 401 });
    await db.query(`UPDATE agent_tokens SET max_uses = NULL, expires_at = NOW() - INTERVAL '1 minute' WHERE id=$1`, [tokenId]);
    expect(await reg(token, "c")).toMatchObject({ ok: false, status: 401 });
  });

  it("ingest with the agent's secret works; another agent's secret on this id is 404", async () => {
    const { token } = await setup();
    const a = await reg(token, "host-a");
    const b = await reg(token, "host-b");
    if (!a.ok || !b.ok) throw new Error("setup");
    expect((await authorizeAgentIngest(req(a.agentSecret), a.agent.id)).ok).toBe(true);
    const cross = await authorizeAgentIngest(req(a.agentSecret), b.agent.id);
    expect(cross).toMatchObject({ ok: false, status: 404 });
  });

  it("unknown hda_ secret is 401", async () => {
    const { token } = await setup();
    const a = await reg(token, "host-a");
    if (!a.ok) throw new Error("setup");
    expect(await authorizeAgentIngest(req("hda_nope"), a.agent.id)).toMatchObject({ ok: false, status: 401 });
  });

  it("revoked agent: secret and legacy token both get 401; register is refused", async () => {
    const { token } = await setup();
    const a = await reg(token, "host-a");
    if (!a.ok) throw new Error("setup");
    const db = await getDb();
    await db.query(`UPDATE agents SET revoked_at = NOW() WHERE id=$1`, [a.agent.id]);
    expect(await authorizeAgentIngest(req(a.agentSecret), a.agent.id)).toMatchObject({ ok: false, status: 401 });
    expect(await authorizeAgentIngest(req(token), a.agent.id)).toMatchObject({ ok: false, status: 401 });
    expect(await reg(token, "host-a", a.agentSecret)).toMatchObject({ ok: false, status: 403 });
  });

  it("legacy token ingest works, warns once per day, and HEIMDALL_LEGACY_TOKENS=off disables it", async () => {
    const { token } = await setup();
    const a = await reg(token, "host-a");
    if (!a.ok) throw new Error("setup");
    // Legacy agent: registered before per-agent secrets, so it has none.
    await (await getDb()).query(`UPDATE agents SET secret_hash = NULL WHERE id=$1`, [a.agent.id]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await authorizeAgentIngest(req(token), a.agent.id)).ok).toBe(true);
    expect((await authorizeAgentIngest(req(token), a.agent.id)).ok).toBe(true);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("legacy_token"))).toHaveLength(1);
    const db = await getDb();
    expect((await db.query(`SELECT legacy_warned_at FROM agents WHERE id=$1`, [a.agent.id])).rows[0]).toMatchObject({
      legacy_warned_at: expect.anything(),
    });
    await db.query(`UPDATE agents SET legacy_warned_at = NOW() - INTERVAL '2 days' WHERE id=$1`, [a.agent.id]);
    await authorizeAgentIngest(req(token), a.agent.id);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("legacy_token"))).toHaveLength(2);

    process.env.HEIMDALL_LEGACY_TOKENS = "off";
    expect(await authorizeAgentIngest(req(token), a.agent.id)).toMatchObject({ ok: false, status: 401 });
    // (Per-agent secret auth under LEGACY_TOKENS=off is covered by the secret tests above;
    // this agent's secret was cleared to model a pre-secret legacy agent.)
    warn.mockRestore();
  });
});
