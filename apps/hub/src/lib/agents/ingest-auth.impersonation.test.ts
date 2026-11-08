import { beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDbForTests } from "@/lib/db/client";
import { createAgentToken, createOrgAndAdmin, registerAgentPersistent } from "@/lib/db/store";
import { authorizeAgentIngest } from "./ingest-auth";

const req = (token: string) =>
  new Request("http://hub.local/api/v1/agents/metrics", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });

describe("shared tokens cannot impersonate agents that have their own secret", () => {
  let orgId: string;
  beforeEach(async () => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "bootstrap-token-impersonation-test-0123";
    delete process.env.HEIMDALL_LEGACY_TOKENS;
    delete process.env.DATABASE_URL;
    resetDbForTests();
    orgId = (await createOrgAndAdmin({
      orgName: "Ops", adminName: "A", email: "a@example.com", password: "Correct-Horse-Battery-9",
    })).org.id;
  });

  it("refuses the enrollment token for an agent that holds an hda_ secret", async () => {
    const { token } = await createAgentToken({ orgId, name: "fleet" });
    const victim = await registerAgentPersistent({ token, hostname: "victim", version: "1" });
    if (!victim.ok) throw new Error("register");
    // Another host holding the same enrollment token tries to post as the victim.
    expect(await authorizeAgentIngest(req(token), victim.agent.id)).toMatchObject({ ok: false, status: 401 });
    // The victim's own secret still works.
    expect(await authorizeAgentIngest(req(victim.agentSecret!), victim.agent.id)).toMatchObject({ ok: true });
  });

  it("refuses the bootstrap token for an agent that holds an hda_ secret", async () => {
    const r = await registerAgentPersistent({
      token: process.env.HEIMDALL_BOOTSTRAP_TOKEN!, hostname: "victim2", version: "1",
    });
    if (!r.ok) throw new Error("register");
    expect(
      await authorizeAgentIngest(req(process.env.HEIMDALL_BOOTSTRAP_TOKEN!), r.agent.id),
    ).toMatchObject({ ok: false, status: 401 });
  });

  it("still lets a legacy agent (no secret yet) use the shared token during the grace period", async () => {
    const { token } = await createAgentToken({ orgId, name: "legacy" });
    const r = await registerAgentPersistent({ token, hostname: "old", version: "1" });
    if (!r.ok) throw new Error("register");
    await (await getDb()).query(`UPDATE agents SET secret_hash = NULL WHERE id = $1`, [r.agent.id]);
    expect(await authorizeAgentIngest(req(token), r.agent.id)).toMatchObject({ ok: true });
  });

  it("a spent limited-use enrollment token no longer authenticates ingest", async () => {
    const { token } = await createAgentToken({ orgId, name: "once", maxUses: 1 });
    const r = await registerAgentPersistent({ token, hostname: "once", version: "1" });
    if (!r.ok) throw new Error("register");
    await (await getDb()).query(`UPDATE agents SET secret_hash = NULL WHERE id = $1`, [r.agent.id]);
    expect(await authorizeAgentIngest(req(token), r.agent.id)).toMatchObject({ ok: false, status: 401 });
  });
});
