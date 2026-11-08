import { beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDbForTests } from "@/lib/db/client";
import {
  createOrgAndAdmin,
  createAgentToken,
  registerAgentPersistent,
} from "@/lib/db/store";
import { authorizeAgentIngest } from "./ingest-auth";

function requestWithToken(token?: string): Request {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request("http://hub.local/api/v1/agents/metrics", {
    method: "POST",
    headers,
  });
}


// Legacy agents registered before per-agent secrets existed: no secret_hash.
async function makeLegacy(agentId: string) {
  await (await getDb()).query(`UPDATE agents SET secret_hash = NULL WHERE id = $1`, [agentId]);
}

describe("authorizeAgentIngest", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "test-token";
    delete process.env.DATABASE_URL;
    resetDbForTests();
  });

  it("rejects missing token", async () => {
    const result = await authorizeAgentIngest(requestWithToken(), "agt_x");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
  });

  it("rejects invalid token", async () => {
    const result = await authorizeAgentIngest(
      requestWithToken("wrong"),
      "agt_x",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
  });

  it("accepts bootstrap token for a matching legacy agent", async () => {
    const reg = await registerAgentPersistent({
      token: "test-token",
      hostname: "edge-01",
      version: "0.0.1",
    });
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;
    await makeLegacy(reg.agent.id);

    const result = await authorizeAgentIngest(
      requestWithToken("test-token"),
      reg.agent.id,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.id).toBe(reg.agent.id);
  });

  it("accepts minted agent token for a legacy agent in the same org", async () => {
    const { org, user } = await createOrgAndAdmin({
      orgName: "Ops",
      adminName: "Admin",
      email: "ops@example.com",
      password: "CorrectHorse1",
    });
    const { token } = await createAgentToken({
      orgId: org.id,
      name: "fleet",
      createdBy: user.id,
    });
    const reg = await registerAgentPersistent({
      token,
      hostname: "edge-02",
      version: "0.0.1",
    });
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;
    await makeLegacy(reg.agent.id);

    const result = await authorizeAgentIngest(
      requestWithToken(token),
      reg.agent.id,
    );
    expect(result.ok).toBe(true);
  });

  it("returns 404 when token org does not own agentId", async () => {
    const a = await createOrgAndAdmin({
      orgName: "A",
      adminName: "Admin A",
      email: "a@example.com",
      password: "CorrectHorse1",
    });
    const b = await createOrgAndAdmin({
      orgName: "B",
      adminName: "Admin B",
      email: "b@example.com",
      password: "CorrectHorse1",
    });
    const { token: tokenA } = await createAgentToken({
      orgId: a.org.id,
      name: "a",
      createdBy: a.user.id,
    });
    const { token: tokenB } = await createAgentToken({
      orgId: b.org.id,
      name: "b",
      createdBy: b.user.id,
    });
    const regA = await registerAgentPersistent({
      token: tokenA,
      hostname: "host-a",
      version: "0.0.1",
    });
    expect(regA.ok).toBe(true);
    if (!regA.ok) return;

    const result = await authorizeAgentIngest(
      requestWithToken(tokenB),
      regA.agent.id,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });
});
