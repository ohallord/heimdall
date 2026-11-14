import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/http-guard/safe-fetch", async (orig) => ({
  ...(await orig<typeof import("@/lib/http-guard/safe-fetch")>()),
  guardedFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));
import { resetAlertCooldowns } from "@/lib/alerts/cooldown";
import { setAlertSustainSeconds } from "@/lib/alerts/sustain-settings";
import { resetSustainState } from "@/lib/alerts/sustain";
import { getDb, resetDbForTests } from "@/lib/db/client";
import { createOrgAndAdmin, registerAgentPersistent, upsertAlertChannel } from "@/lib/db/store";
import { ingestAgentMetrics } from "./ingest";

const T0 = new Date("2026-11-14T12:00:00Z").getTime();

describe("alert sustain window in metrics ingest", () => {
  let orgId = "";
  let agentId = "";
  const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));

  async function ingestCpuAt(offsetSec: number, cpu: number) {
    vi.setSystemTime(T0 + offsetSec * 1000);
    const r = await ingestAgentMetrics({ agentId, cpuPercent: cpu, memPercent: 10 });
    expect(r.ok).toBe(true);
    // enqueueAlert delivers off the request path; let it flush.
    await new Promise((res) => setImmediate(res));
  }

  async function cpuEvents() {
    const db = await getDb();
    const r = await db.query<{ message: string; status: string }>(
      `SELECT message, status FROM alert_events WHERE org_id = $1 AND message LIKE 'cpu_percent%'`,
      [orgId],
    );
    return r.rows;
  }

  beforeEach(async () => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "test-token";
    delete process.env.DATABASE_URL;
    resetDbForTests();
    resetAlertCooldowns();
    resetSustainState();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const { org } = await createOrgAndAdmin({
      orgName: "Sustain Ingest",
      adminName: "Admin",
      email: "si@example.com",
      password: "CorrectHorse1",
    });
    orgId = org.id;
    await upsertAlertChannel({ orgId, kind: "slack", config: { url: "https://hooks.example/slack" } });
    const reg = await registerAgentPersistent({ token: "test-token", hostname: "flappy", version: "1" });
    if (!reg.ok) throw new Error("register failed");
    agentId = reg.agent.id;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens no alert, and sends nothing, for a breach that clears inside the window", async () => {
    await setAlertSustainSeconds(orgId, 120);
    await ingestCpuAt(0, 99); // red
    await ingestCpuAt(20, 99);
    await ingestCpuAt(40, 12); // green again after 40s
    await ingestCpuAt(60, 12);
    expect(await cpuEvents()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens the alert once the breach has lasted the whole window", async () => {
    await setAlertSustainSeconds(orgId, 120);
    await ingestCpuAt(0, 99);
    await ingestCpuAt(60, 99);
    expect(await cpuEvents()).toEqual([]);
    await ingestCpuAt(121, 99);
    const events = await cpuEvents();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.status === "open")).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("restarts the window when a blip interrupts the breach", async () => {
    await setAlertSustainSeconds(orgId, 120);
    await ingestCpuAt(0, 99);
    await ingestCpuAt(100, 12); // recovered just before firing
    await ingestCpuAt(110, 99); // breach again: clock restarts at 110
    await ingestCpuAt(200, 99); // only 90s into the new breach
    expect(await cpuEvents()).toEqual([]);
    await ingestCpuAt(231, 99);
    expect((await cpuEvents()).length).toBeGreaterThanOrEqual(1);
  });

  it("a window of 0 alerts on the first breaching sample", async () => {
    await setAlertSustainSeconds(orgId, 0);
    await ingestCpuAt(0, 99);
    expect((await cpuEvents()).length).toBeGreaterThanOrEqual(1);
  });
});
