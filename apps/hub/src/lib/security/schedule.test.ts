import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ingestSecurityScan = vi.fn();
vi.mock("./sync", () => ({
  ingestSecurityScan: (...args: unknown[]) => ingestSecurityScan(...args),
}));

import { getDb, resetDbForTests } from "@/lib/db/client";
import { DEFAULT_SECURITY_SYNC_CRON } from "./cron";
import {
  getSecuritySyncSchedule,
  hubTimeZone,
  runDueSecuritySyncs,
  saveSecuritySyncSchedule,
} from "./schedule";

async function makeOrg(id: string) {
  const db = await getDb();
  await db.query(`INSERT INTO organizations (id, name) VALUES ($1, $1)`, [id]);
}

describe("security sync schedule", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    delete process.env.DATABASE_URL;
    process.env.HEIMDALL_TZ = "UTC";
    resetDbForTests();
    ingestSecurityScan.mockReset();
    ingestSecurityScan.mockResolvedValue({ written: 2, bySource: { github: 2 }, errors: [] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.HEIMDALL_TZ;
    vi.restoreAllMocks();
  });

  it("defaults to enabled, daily at 08:00 in the hub time zone", async () => {
    await makeOrg("org_a");
    const s = await getSecuritySyncSchedule("org_a", new Date("2026-11-14T07:00:00Z"));
    expect(s.cron).toBe(DEFAULT_SECURITY_SYNC_CRON);
    expect(s.enabled).toBe(true);
    expect(s.timeZone).toBe("UTC");
    expect(s.nextRunAt).toBe("2026-11-14T08:00:00.000Z");
    expect(s.lastRunAt).toBeNull();
  });

  it("uses HEIMDALL_TZ, then TZ, then the server zone", () => {
    process.env.HEIMDALL_TZ = "Europe/Dublin";
    expect(hubTimeZone()).toBe("Europe/Dublin");
    process.env.HEIMDALL_TZ = "Not/AZone";
    process.env.TZ = "America/Chicago";
    expect(hubTimeZone()).toBe("America/Chicago");
    delete process.env.HEIMDALL_TZ;
    delete process.env.TZ;
    expect(hubTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("rejects an invalid cron on save", async () => {
    await makeOrg("org_a");
    await expect(
      saveSecuritySyncSchedule("org_a", { cron: "61 * * * *", enabled: true }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("runs sync only for enabled orgs whose cron has fired, once per tick", async () => {
    await makeOrg("org_on");
    await makeOrg("org_off");
    await makeOrg("org_later");
    const t0 = new Date("2026-11-14T07:00:00Z");
    await saveSecuritySyncSchedule("org_on", { cron: "0 8 * * *", enabled: true }, t0);
    await saveSecuritySyncSchedule("org_off", { cron: "0 8 * * *", enabled: false }, t0);
    await saveSecuritySyncSchedule("org_later", { cron: "0 9 * * *", enabled: true }, t0);

    const tick = new Date("2026-11-14T08:00:20Z");
    const ran = await runDueSecuritySyncs(tick);
    expect(ran).toEqual(["org_on"]);
    expect(ingestSecurityScan).toHaveBeenCalledTimes(1);
    expect(ingestSecurityScan).toHaveBeenCalledWith({ orgId: "org_on", syncRemotes: true });

    // A second poll (or a restarted hub) in the same minute does not run it again.
    expect(await runDueSecuritySyncs(new Date("2026-11-14T08:00:50Z"))).toEqual([]);
    expect(ingestSecurityScan).toHaveBeenCalledTimes(1);

    const s = await getSecuritySyncSchedule("org_on", tick);
    expect(s.lastRunStatus).toBe("ok");
    expect(s.lastRunAt).not.toBeNull();
    expect(s.lastRunWritten).toBe(2);
    expect(s.nextRunAt).toBe("2026-11-15T08:00:00.000Z");
  });

  it("claims a tick once when two pollers race", async () => {
    await makeOrg("org_on");
    await saveSecuritySyncSchedule(
      "org_on",
      { cron: "0 8 * * *", enabled: true },
      new Date("2026-11-14T07:00:00Z"),
    );
    const tick = new Date("2026-11-14T08:00:05Z");
    const [a, b] = await Promise.all([runDueSecuritySyncs(tick), runDueSecuritySyncs(tick)]);
    expect([...a, ...b]).toEqual(["org_on"]);
    expect(ingestSecurityScan).toHaveBeenCalledTimes(1);
  });

  it("records warnings and errors for the admin screen", async () => {
    await makeOrg("org_w");
    await makeOrg("org_e");
    const t0 = new Date("2026-11-14T07:00:00Z");
    await saveSecuritySyncSchedule("org_w", { cron: "0 8 * * *", enabled: true }, t0);
    await saveSecuritySyncSchedule("org_e", { cron: "0 8 * * *", enabled: true }, t0);
    ingestSecurityScan.mockImplementation(async ({ orgId }: { orgId: string }) => {
      if (orgId === "org_e") throw new Error("db down");
      return { written: 0, bySource: {}, errors: ["github:acme missing token"] };
    });

    const tick = new Date("2026-11-14T08:00:00Z");
    expect((await runDueSecuritySyncs(tick)).sort()).toEqual(["org_e", "org_w"]);

    const w = await getSecuritySyncSchedule("org_w", tick);
    expect(w.lastRunStatus).toBe("warnings");
    expect(w.lastRunWarnings).toEqual(["github:acme missing token"]);
    const e = await getSecuritySyncSchedule("org_e", tick);
    expect(e.lastRunStatus).toBe("error");
    expect(e.lastRunWarnings).toEqual(["db down"]);
  });

  it("gives orgs without a saved schedule the default and runs them", async () => {
    await makeOrg("org_new");
    expect(await runDueSecuritySyncs(new Date("2026-11-14T07:00:00Z"))).toEqual([]);
    expect(await runDueSecuritySyncs(new Date("2026-11-14T08:00:30Z"))).toEqual(["org_new"]);
  });
});
