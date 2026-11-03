import { beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests, getDb } from "@/lib/db/client";
import { createOrgAndAdmin } from "@/lib/db/store";
import {
  listFindings,
  resolveFinding,
  upsertFindings,
  upsertFindingsDetailed,
} from "./store";
import { setCriticalFindingsToAlarms } from "./settings";
import type { NormalizedFinding } from "./types";

function criticalFinding(
  overrides: Partial<NormalizedFinding> = {},
): NormalizedFinding {
  return {
    source: "host_posture",
    externalId: "CVE-2024-TEST",
    title: "Critical rootfs package",
    severity: "critical",
    packageName: "openssl",
    packageVersion: "1.0.0",
    fixedVersion: "1.0.1",
    resource: "host-rootfs",
    cve: "CVE-2024-TEST",
    url: "https://example.com/cve",
    agentId: "agt_posture",
    raw: { Severity: "CRITICAL" },
    ...overrides,
  };
}

describe("findings depth + critical→alarms", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    delete process.env.DATABASE_URL;
    resetDbForTests();
  });

  it("resolves a finding and removes it from open list", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "Resolve Org",
      adminName: "Admin",
      email: "resolve@example.com",
      password: "CorrectHorse1",
    });
    const db = await getDb();
    await db.query(
      `INSERT INTO agents (id, org_id, hostname, version)
       VALUES ($1, $2, 'host-a', '0.1')`,
      ["agt_posture", org.id],
    );

    await upsertFindings(org.id, [criticalFinding()]);
    const open = await listFindings(org.id);
    expect(open).toHaveLength(1);

    const resolved = await resolveFinding(org.id, open[0]!.id);
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolved_at).toBeTruthy();
    expect(await listFindings(org.id)).toHaveLength(0);
  });

  it("raises an alarm for a new critical finding by default", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "Alarm Org",
      adminName: "Admin",
      email: "alarm@example.com",
      password: "CorrectHorse1",
    });
    const db = await getDb();
    await db.query(
      `INSERT INTO agents (id, org_id, hostname, version)
       VALUES ($1, $2, 'host-a', '0.1')`,
      ["agt_posture", org.id],
    );

    const result = await upsertFindingsDetailed(org.id, [criticalFinding()]);
    expect(result.written).toBe(1);
    expect(result.alarmsRaised).toBe(1);

    const events = await db.query<{ severity: string; message: string }>(
      `SELECT severity, message FROM alert_events WHERE org_id = $1`,
      [org.id],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.severity).toBe("critical");
    expect(events.rows[0]!.message).toMatch(/critical host_posture/i);

    // Idempotent upsert: no second alarm
    const again = await upsertFindingsDetailed(org.id, [criticalFinding()]);
    expect(again.alarmsRaised).toBe(0);
    const events2 = await db.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM alert_events WHERE org_id = $1`,
      [org.id],
    );
    expect(events2.rows[0]!.c).toBe(1);
  });

  it("skips alarms when criticalFindingsToAlarms is false", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "Off Org",
      adminName: "Admin",
      email: "off@example.com",
      password: "CorrectHorse1",
    });
    const db = await getDb();
    await db.query(
      `INSERT INTO agents (id, org_id, hostname, version)
       VALUES ($1, $2, 'host-a', '0.1')`,
      ["agt_posture", org.id],
    );
    await setCriticalFindingsToAlarms(org.id, false);

    const result = await upsertFindingsDetailed(org.id, [criticalFinding()]);
    expect(result.written).toBe(1);
    expect(result.alarmsRaised).toBe(0);

    const events = await db.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM alert_events WHERE org_id = $1`,
      [org.id],
    );
    expect(events.rows[0]!.c).toBe(0);
  });

  it("does not raise for high severity", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "High Org",
      adminName: "Admin",
      email: "high@example.com",
      password: "CorrectHorse1",
    });
    const result = await upsertFindingsDetailed(org.id, [
      criticalFinding({
        severity: "high",
        externalId: "CVE-HIGH",
        agentId: undefined,
      }),
    ]);
    expect(result.alarmsRaised).toBe(0);
  });
});
