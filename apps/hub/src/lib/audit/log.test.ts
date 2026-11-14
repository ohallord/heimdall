import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDbForTests } from "@/lib/db/client";
import { listAudit, purgeAudit, recordAudit, redactDetail } from "./log";

async function makeOrg(id: string) {
  const db = await getDb();
  await db.query(`INSERT INTO organizations (id, name) VALUES ($1, $1)`, [id]);
}

describe("audit log", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    delete process.env.DATABASE_URL;
    resetDbForTests();
  });

  it("records an entry with actor, target and detail", async () => {
    await makeOrg("org_a");
    await recordAudit({
      session: { orgId: "org_a", userId: "u1", email: "a@x.io" },
      request: new Request("http://hub/x"),
      action: "org.settings.update",
      target: "org_a",
      detail: { logsRetentionDays: 14 },
    });
    const { rows } = await listAudit("org_a", {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "org.settings.update",
      actorUserId: "u1",
      actorEmail: "a@x.io",
      target: "org_a",
      detail: { logsRetentionDays: 14 },
    });
  });

  it("redacts secret-looking keys at any depth", () => {
    expect(
      redactDetail({
        name: "n",
        token: "abc",
        nested: { webhookUrl: "https://h/x", apiKey: "k", password: "p", ok: 1 },
      }),
    ).toEqual({
      name: "n",
      token: "[redacted]",
      nested: { webhookUrl: "[redacted]", apiKey: "[redacted]", password: "[redacted]", ok: 1 },
    });
  });

  it("never throws into the caller", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // an unknown org violates the foreign key, so the insert fails
    await expect(
      recordAudit({ session: { orgId: "missing", userId: "u" }, action: "x.y" }),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("[audit]"), expect.anything());
    spy.mockRestore();
  });

  it("paginates newest first and filters by action", async () => {
    await makeOrg("org_a");
    for (let i = 0; i < 5; i++) {
      await recordAudit({
        session: { orgId: "org_a" },
        action: i % 2 ? "alert.rule.update" : "org.settings.update",
        detail: { i },
      });
    }
    const p1 = await listAudit("org_a", { limit: 2 });
    expect(p1.rows).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await listAudit("org_a", { limit: 2, cursor: p1.nextCursor! });
    expect(p2.rows).toHaveLength(2);
    const ids = new Set([...p1.rows, ...p2.rows].map((r) => r.id));
    expect(ids.size).toBe(4);
    const f = await listAudit("org_a", { action: "alert.rule.update" });
    expect(f.rows).toHaveLength(2);
    expect(f.rows.every((r) => r.action === "alert.rule.update")).toBe(true);
  });

  it("purges rows older than the cutoff", async () => {
    await makeOrg("org_a");
    const db = await getDb();
    await recordAudit({ session: { orgId: "org_a" }, action: "new.one" });
    await db.query(
      `INSERT INTO audit_log (id, org_id, action, created_at) VALUES ('old', 'org_a', 'old.one', NOW() - INTERVAL '40 days')`,
    );
    const removed = await purgeAudit("org_a", new Date(Date.now() - 30 * 86_400_000).toISOString());
    expect(removed).toBe(1);
    expect((await listAudit("org_a", {})).rows).toHaveLength(1);
  });
});
