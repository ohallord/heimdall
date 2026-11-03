import { beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDbForTests } from "@/lib/db/client";
import { createOrgAndAdmin } from "@/lib/db/store";
import {
  clampRetentionDays,
  DEFAULT_RETENTION_DAYS,
  getLogsRetentionDays,
  getMetricsRetentionDays,
  purgeOrgLogsAndAlerts,
  setLogsRetentionDays,
} from "./retention";

const DAY = 86_400_000;

async function mkOrg(email: string) {
  const { org } = await createOrgAndAdmin({
    orgName: email,
    adminName: "a",
    email,
    password: "pw-long-enough-123",
  });
  return org.id;
}

describe("retention defaults and purge", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "test-token";
    delete process.env.DATABASE_URL;
    resetDbForTests();
  });

  it("defaults to 60 days for metrics and logs when unset", async () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(60);
    const orgId = await mkOrg("a@example.com");
    expect(await getMetricsRetentionDays(orgId)).toBe(60);
    expect(await getLogsRetentionDays(orgId)).toBe(60);
  });

  it("clamps logs retention and keeps an explicitly saved value", async () => {
    const orgId = await mkOrg("b@example.com");
    expect(await setLogsRetentionDays(orgId, 5)).toBe(30);
    expect(await setLogsRetentionDays(orgId, 90)).toBe(90);
    expect(await getLogsRetentionDays(orgId)).toBe(90);
    expect(clampRetentionDays(Number.NaN)).toBe(60);
  });

  it("purges only old logs and closed alerts, per org", async () => {
    const a = await mkOrg("c@example.com");
    const b = await mkOrg("d@example.com");
    const db = await getDb();
    const old = new Date(Date.now() - 61 * DAY).toISOString();
    const fresh = new Date(Date.now() - 1 * DAY).toISOString();
    for (const [id, org, ts] of [
      ["l_old_a", a, old],
      ["l_new_a", a, fresh],
      ["l_old_b", b, old],
    ] as const) {
      await db.query(
        `INSERT INTO log_events (id, org_id, source, line, observed_at)
         VALUES ($1,$2,'s','x',$3)`,
        [id, org, ts],
      );
    }
    for (const [id, status] of [
      ["al_old_open", "open"],
      ["al_old_closed", "dismissed"],
    ] as const) {
      await db.query(
        `INSERT INTO alert_events (id, org_id, message, created_at, status)
         VALUES ($1,$2,'m',$3,$4)`,
        [id, a, old, status],
      );
    }

    const res = await purgeOrgLogsAndAlerts(a);
    expect(res).toEqual({ logs: 1, alerts: 1 });

    const logs = await db.query<{ id: string }>(
      `SELECT id FROM log_events ORDER BY id`,
    );
    expect(logs.rows.map((r) => r.id)).toEqual(["l_new_a", "l_old_b"]);
    const alerts = await db.query<{ id: string }>(
      `SELECT id FROM alert_events`,
    );
    expect(alerts.rows.map((r) => r.id)).toEqual(["al_old_open"]);
  });
});
