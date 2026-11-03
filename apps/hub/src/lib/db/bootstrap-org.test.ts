import { beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "./client";
import {
  createOrgAndAdmin,
  ensureBootstrapOrg,
  getOrgWithAdmins,
  getPrimaryOrg,
  listAgentsPersistent,
  registerAgentPersistent,
} from "./store";
import { getDb } from "./client";
import { newId } from "@/lib/ids";

describe("bootstrap org selection", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "test-token";
    delete process.env.DATABASE_URL;
    delete process.env.HEIMDALL_ORG_ID;
    resetDbForTests();
  });

  it("creates Bootstrap when no orgs exist", async () => {
    const org = await ensureBootstrapOrg();
    expect(org.name).toBe("Bootstrap");
    expect(await getPrimaryOrg()).toEqual(org);
  });

  it("prefers org with admin users over empty Bootstrap", async () => {
    const { org: ops } = await createOrgAndAdmin({
      orgName: "Heimdall Ops",
      adminName: "Dan",
      email: "dan@example.com",
      password: "CorrectHorse1",
    });

    // Dual-org path: older empty Bootstrap (what getPrimaryOrg would pick).
    const db = await getDb();
    const emptyBootstrap = newId("org");
    await db.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [
      emptyBootstrap,
      "Bootstrap",
    ]);
    await db.query(
      `UPDATE organizations SET created_at = NOW() - INTERVAL '1 day' WHERE id = $1`,
      [emptyBootstrap],
    );

    expect((await getPrimaryOrg())?.id).toBe(emptyBootstrap);
    const preferred = await ensureBootstrapOrg();
    expect(preferred.id).toBe(ops.id);
    expect(preferred.name).toBe("Heimdall Ops");
    expect((await getOrgWithAdmins())?.id).toBe(ops.id);
  });

  it("honors HEIMDALL_ORG_ID over org-with-admins", async () => {
    const { org: ops } = await createOrgAndAdmin({
      orgName: "Heimdall Ops",
      adminName: "Dan",
      email: "dan@example.com",
      password: "CorrectHorse1",
    });
    const db = await getDb();
    const otherId = newId("org");
    await db.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [
      otherId,
      "Pinned",
    ]);
    process.env.HEIMDALL_ORG_ID = otherId;

    const preferred = await ensureBootstrapOrg();
    expect(preferred.id).toBe(otherId);
    expect(preferred.id).not.toBe(ops.id);
  });

  it("bootstrap register attaches to org with admins in dual-org case", async () => {
    const { org: ops } = await createOrgAndAdmin({
      orgName: "Heimdall Ops",
      adminName: "Dan",
      email: "dan2@example.com",
      password: "CorrectHorse1",
    });

    const db = await getDb();
    const emptyId = newId("org");
    await db.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [
      emptyId,
      "Bootstrap",
    ]);
    await db.query(
      `UPDATE organizations SET created_at = NOW() - INTERVAL '2 days' WHERE id = $1`,
      [emptyId],
    );
    expect((await getPrimaryOrg())?.id).toBe(emptyId);

    const registered = await registerAgentPersistent({
      token: "test-token",
      hostname: "helm-agent-01",
      version: "0.1.0",
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    expect(registered.agent.org_id).toBe(ops.id);

    const fleet = await listAgentsPersistent(ops.id);
    expect(fleet.map((a) => a.id)).toContain(registered.agent.id);
  });

  it("bootstrap re-register moves agent off empty Bootstrap into ops org", async () => {
    const db = await getDb();
    // Agent registers first → Bootstrap (no users yet).
    const first = await registerAgentPersistent({
      token: "test-token",
      hostname: "helm-agent-01",
      version: "0.1.0",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect((await getPrimaryOrg())?.name).toBe("Bootstrap");

    // Wizard creates Heimdall Ops by adopting Bootstrap.
    const { org: ops } = await createOrgAndAdmin({
      orgName: "Heimdall Ops",
      adminName: "Dan",
      email: "dan3@example.com",
      password: "CorrectHorse1",
    });
    expect(ops.id).toBe(first.agent.org_id);
    expect(ops.name).toBe("Heimdall Ops");

    // Simulate dual-org regression: agent stuck on a new empty Bootstrap.
    const staleBootstrap = newId("org");
    await db.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [
      staleBootstrap,
      "Bootstrap",
    ]);
    await db.query(
      `UPDATE organizations SET created_at = NOW() - INTERVAL '3 days' WHERE id = $1`,
      [staleBootstrap],
    );
    await db.query(`UPDATE agents SET org_id = $1 WHERE id = $2`, [
      staleBootstrap,
      first.agent.id,
    ]);

    const again = await registerAgentPersistent({
      token: "test-token",
      hostname: "helm-agent-01",
      version: "0.1.1",
      agentSecret: first.agentSecret,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.agent.id).toBe(first.agent.id);
    expect(again.agent.org_id).toBe(ops.id);
    expect(again.agent.version).toBe("0.1.1");
  });

  it("wizard adopts userless Bootstrap instead of creating a second org", async () => {
    await registerAgentPersistent({
      token: "test-token",
      hostname: "early-agent",
      version: "0.0.1",
    });
    const bootstrap = await getPrimaryOrg();
    expect(bootstrap?.name).toBe("Bootstrap");

    const { org } = await createOrgAndAdmin({
      orgName: "Heimdall Ops",
      adminName: "Dan",
      email: "dan4@example.com",
      password: "CorrectHorse1",
    });
    expect(org.id).toBe(bootstrap!.id);
    expect(org.name).toBe("Heimdall Ops");

    const db = await getDb();
    const orgs = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM organizations`,
    );
    expect(orgs.rows[0].n).toBe("1");
  });
});
