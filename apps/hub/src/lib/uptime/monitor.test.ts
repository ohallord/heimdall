import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/http-guard/safe-fetch", async (orig) => ({
  ...(await orig<typeof import("@/lib/http-guard/safe-fetch")>()),
  guardedFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));
import { setAlertSustainSeconds } from "@/lib/alerts/sustain-settings";
import { getDb, resetDbForTests } from "@/lib/db/client";
import { createOrgAndAdmin, upsertAlertChannel } from "@/lib/db/store";
import { isDown, resolveUptimeAlarmSilently, runDueUptimeChecks, uptimeFingerprint } from "./monitor";
import type { ProbeResult } from "./probe";
import { createUptimeCheck, getUptimeCheck, setUptimeCheckEnabled, deleteUptimeCheck } from "./store";

const T0 = new Date("2026-11-14T12:00:00Z").getTime();
const at = (sec: number) => new Date(T0 + sec * 1000);
const flush = () => new Promise((r) => setImmediate(r));

describe("uptime monitor", () => {
  let orgId = "";
  const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok", { status: 200 }));
  let result: ProbeResult = { ok: true, latencyMs: 12 };
  const probe = vi.fn(async () => result);

  const events = async () =>
    (await (await getDb()).query<{ id: string; status: string; fingerprint: string; severity: string; message: string }>(
      `SELECT id, status, fingerprint, severity, message FROM alert_events WHERE org_id = $1 ORDER BY created_at ASC`,
      [orgId],
    )).rows;
  const slackBodies = () => fetchMock.mock.calls.map((c) => String(c[1]?.body));
  const newCheck = (over: Partial<Parameters<typeof createUptimeCheck>[1]> = {}) =>
    createUptimeCheck(orgId, { name: "API", kind: "http", target: "https://api.example.com/health", intervalSeconds: 60, ...over });

  beforeEach(async () => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "test-token";
    delete process.env.DATABASE_URL;
    resetDbForTests();
    fetchMock.mockClear();
    probe.mockClear();
    result = { ok: true, latencyMs: 12 };
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { org } = await createOrgAndAdmin({ orgName: "Up", adminName: "A", email: "up@example.com", password: "CorrectHorse1" });
    orgId = org.id;
    await upsertAlertChannel({ orgId, kind: "slack", config: { url: "https://hooks.example/slack" } });
    await setAlertSustainSeconds(orgId, 120);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("scheduling", () => {
    it("runs a due check once per tick, not again until its interval passes", async () => {
      const c = await newCheck();
      expect(await runDueUptimeChecks(at(0), { probe })).toEqual([c.id]);
      expect(await runDueUptimeChecks(at(0), { probe })).toEqual([]);
      expect(await runDueUptimeChecks(at(30), { probe })).toEqual([]);
      expect(await runDueUptimeChecks(at(60), { probe })).toEqual([c.id]);
      expect(probe).toHaveBeenCalledTimes(2);
      const row = await getUptimeCheck(orgId, c.id);
      expect(row).toMatchObject({ last_status: "up", last_latency_ms: 12, consecutive_failures: 0 });
    });

    it("two overlapping passes run each check exactly once", async () => {
      await newCheck();
      await newCheck({ name: "DB", kind: "tcp", target: "db.example.com:5432" });
      const [a, b] = await Promise.all([runDueUptimeChecks(at(0), { probe }), runDueUptimeChecks(at(0), { probe })]);
      expect(a.length + b.length).toBe(2);
      expect(probe).toHaveBeenCalledTimes(2);
    });

    it("skips disabled checks and restarts the streak when re-enabled", async () => {
      const c = await newCheck();
      await setUptimeCheckEnabled(orgId, c.id, false);
      expect(await runDueUptimeChecks(at(0), { probe })).toEqual([]);
      await setUptimeCheckEnabled(orgId, c.id, true);
      expect(await runDueUptimeChecks(at(10), { probe })).toEqual([c.id]);
    });

    it("keeps going when one probe throws", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const a = await newCheck({ name: "A" });
      const b = await newCheck({ name: "B" });
      const flaky = vi.fn(async (c: { target: string }) => {
        if (c.target.includes("api")) throw new Error("boom");
        return result;
      });
      await newCheck({ name: "C", kind: "tcp", target: "x.example.com:80" });
      const ran = await runDueUptimeChecks(at(0), { probe: flaky });
      expect(ran).toHaveLength(3);
      expect(a.id).toBeTruthy();
      expect(b.id).toBeTruthy();
    });
  });

  describe("alerting", () => {
    it("opens a critical alarm after the sustain window, once, and notifies channels", async () => {
      const c = await newCheck();
      result = { ok: false, latencyMs: 5000, error: "timeout" };
      for (const s of [0, 60]) await runDueUptimeChecks(at(s), { probe });
      await flush();
      expect(await events()).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();

      await runDueUptimeChecks(at(120), { probe });
      await flush();
      const evs = await events();
      expect(evs).toHaveLength(1);
      expect(evs[0]).toMatchObject({ status: "open", severity: "critical", fingerprint: uptimeFingerprint(orgId, c.id) });
      expect(evs[0].message).toMatch(/API is down: timeout/);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Still down: no second alarm, no second notification.
      await runDueUptimeChecks(at(180), { probe });
      await flush();
      expect(await events()).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await getUptimeCheck(orgId, c.id)).toMatchObject({ last_status: "down", last_error: "timeout", consecutive_failures: 4 });
    });

    it("auto-resolves and sends one recovery when the check comes back", async () => {
      await newCheck();
      result = { ok: false, latencyMs: 1, error: "ECONNREFUSED" };
      for (const s of [0, 60, 120]) await runDueUptimeChecks(at(s), { probe });
      await flush();
      fetchMock.mockClear();

      result = { ok: true, latencyMs: 30 };
      await runDueUptimeChecks(at(180), { probe });
      await flush();
      const evs = await events();
      expect(evs[0].status).toBe("resolved");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(slackBodies()[0]).toMatch(/Recovered|is up/);

      await runDueUptimeChecks(at(240), { probe });
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1); // no repeat recovery
    });

    it("a blip that clears inside the window never alarms or notifies", async () => {
      await newCheck();
      result = { ok: false, latencyMs: 1, error: "reset" };
      await runDueUptimeChecks(at(0), { probe });
      await runDueUptimeChecks(at(60), { probe });
      result = { ok: true, latencyMs: 1 };
      await runDueUptimeChecks(at(120), { probe });
      await flush();
      expect(await events()).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("a window of 0 alarms on the first failure", async () => {
      await setAlertSustainSeconds(orgId, 0);
      await newCheck();
      result = { ok: false, latencyMs: 1, error: "refused" };
      await runDueUptimeChecks(at(0), { probe });
      await flush();
      expect(await events()).toHaveLength(1);
    });

    it("does not open a new alarm while the fingerprint is muted", async () => {
      await setAlertSustainSeconds(orgId, 0);
      const c = await newCheck();
      const db = await getDb();
      await db.query(
        `INSERT INTO alert_events (id, org_id, severity, message, payload_json, status, fingerprint, muted_until)
         VALUES ('evt_m', $1, 'critical', 'x', '{}', 'muted', $2, NOW() + INTERVAL '1 hour')`,
        [orgId, uptimeFingerprint(orgId, c.id)],
      );
      result = { ok: false, latencyMs: 1, error: "refused" };
      await runDueUptimeChecks(at(0), { probe });
      await flush();
      expect(await events()).toHaveLength(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("resolving silently (check deleted or disabled) closes the alarm without notifying", async () => {
      await setAlertSustainSeconds(orgId, 0);
      const c = await newCheck();
      result = { ok: false, latencyMs: 1, error: "refused" };
      await runDueUptimeChecks(at(0), { probe });
      await flush();
      fetchMock.mockClear();
      await resolveUptimeAlarmSilently(orgId, c.id);
      await flush();
      expect((await events())[0].status).toBe("resolved");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await deleteUptimeCheck(orgId, c.id)).toBe(true);
      expect(await getUptimeCheck(orgId, c.id)).toBeNull();
    });
  });

  describe("isDown", () => {
    const since = (s: number) => at(s);
    it("needs two failures and the full window", () => {
      expect(isDown({ consecutiveFailures: 1, failingSince: since(0) }, 120, at(500))).toBe(false);
      expect(isDown({ consecutiveFailures: 2, failingSince: since(0) }, 120, at(119))).toBe(false);
      expect(isDown({ consecutiveFailures: 2, failingSince: since(0) }, 120, at(120))).toBe(true);
      expect(isDown({ consecutiveFailures: 1, failingSince: since(0) }, 0, at(0))).toBe(true);
      expect(isDown({ consecutiveFailures: 0, failingSince: null }, 0, at(0))).toBe(false);
    });
  });
});
