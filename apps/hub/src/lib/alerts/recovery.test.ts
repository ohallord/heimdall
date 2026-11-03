import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueued = vi.hoisted(() => [] as { payload: { kind?: string; subject: string } }[]);
vi.mock("@/lib/alerts/queue", () => ({
  enqueueAlert: (input: { payload: { kind?: string; subject: string } }) => {
    enqueued.push(input);
  },
}));
import { resetAlertCooldowns } from "@/lib/alerts/cooldown";
import { getDb, resetDbForTests } from "@/lib/db/client";
import {
  createOrgAndAdmin,
  dismissAlertEventsBulk,
  insertAlertEvent,
  listAlertEvents,
  registerAgentPersistent,
} from "@/lib/db/store";
import { ingestAgentMetrics } from "@/lib/metrics/ingest";
import { newId } from "@/lib/ids";

const disk = (mountPoint: string, usedPercent: number) => ({
  mountPoint,
  device: "/dev/x",
  totalBytes: 1000,
  usedBytes: usedPercent * 10,
  freeBytes: 1000 - usedPercent * 10,
  usedPercent,
});

async function setup(email: string) {
  const { org, user } = await createOrgAndAdmin({
    orgName: email,
    adminName: "Admin",
    email,
    password: "CorrectHorse1",
  });
  const reg = await registerAgentPersistent({
    token: "test-token",
    hostname: `host-${email}`,
    version: "0.5.0",
  });
  if (!reg.ok) throw new Error("register failed");
  return { org, user, agentId: reg.agent.id };
}

async function statuses(orgId: string) {
  const db = await getDb();
  const r = await db.query<{ status: string; resolved_at: string | null; message: string }>(
    `SELECT status, resolved_at, message FROM alert_events WHERE org_id = $1`,
    [orgId],
  );
  return r.rows;
}

describe("alert auto-recovery", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "test-token";
    delete process.env.DATABASE_URL;
    resetDbForTests();
    resetAlertCooldowns();
    enqueued.length = 0;
  });

  it("resolves an open disk alert once the metric is back under threshold", async () => {
    const { org, agentId } = await setup("rec1@example.com");
    await ingestAgentMetrics({
      agentId,
      cpuPercent: 5,
      memPercent: 5,
      disks: [disk("/", 10), disk("/var", 95)],
    });
    expect((await statuses(org.id)).some((e) => e.status === "open")).toBe(true);

    await ingestAgentMetrics({
      agentId,
      cpuPercent: 5,
      memPercent: 5,
      disks: [disk("/", 10), disk("/var", 40)],
    });
    const rows = await statuses(org.id);
    expect(rows.every((e) => e.status === "resolved")).toBe(true);
    expect(rows.every((e) => e.resolved_at)).toBe(true);
    const queue = await listAlertEvents(org.id, { status: "open_queue" });
    expect(queue).toHaveLength(0);

    // 95% is the warn (yellow) band: history only, so no recovery is sent either.
    expect(enqueued.some((e) => e.payload.kind === "recovery")).toBe(false);
  });

  it("sends one recovery notification when an alarm clears", async () => {
    const { org, agentId } = await setup("rec5@example.com");
    await ingestAgentMetrics({
      agentId,
      cpuPercent: 5,
      memPercent: 5,
      disks: [disk("/", 10), disk("/var", 99)],
    });
    expect(enqueued.filter((e) => e.payload.kind !== "recovery")).toHaveLength(1);

    const healthy = {
      agentId,
      cpuPercent: 5,
      memPercent: 5,
      disks: [disk("/", 10), disk("/var", 40)],
    };
    await ingestAgentMetrics(healthy);
    expect((await statuses(org.id)).every((e) => e.status === "resolved")).toBe(true);
    const recoveries = enqueued.filter((e) => e.payload.kind === "recovery");
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].payload.subject).toContain("host-rec5@example.com");

    // A further healthy sample must not re-send the recovery.
    await ingestAgentMetrics(healthy);
    expect(enqueued.filter((e) => e.payload.kind === "recovery")).toHaveLength(1);
  });

  it("keeps the alert open while the metric is still breaching", async () => {
    const { org, agentId } = await setup("rec2@example.com");
    const body = {
      agentId,
      cpuPercent: 5,
      memPercent: 5,
      disks: [disk("/", 10), disk("/var", 95)],
    };
    await ingestAgentMetrics(body);
    await ingestAgentMetrics(body);
    expect((await statuses(org.id)).every((e) => e.status === "open")).toBe(true);
    expect(enqueued.some((e) => e.payload.kind === "recovery")).toBe(false);
  });

  it("does not resolve a disk alert when the payload omits that disk", async () => {
    const { org, agentId } = await setup("rec3@example.com");
    await ingestAgentMetrics({
      agentId,
      cpuPercent: 5,
      memPercent: 5,
      disks: [disk("/", 10), disk("/var", 95)],
    });
    await ingestAgentMetrics({ agentId, cpuPercent: 5, memPercent: 5 });
    expect((await statuses(org.id)).every((e) => e.status === "open")).toBe(true);
  });

  it("resolves mount_missing when the mount returns", async () => {
    const { org, agentId } = await setup("rec4@example.com");
    await ingestAgentMetrics({
      agentId,
      cpuPercent: 5,
      memPercent: 5,
      mounts: [{ path: "/data", present: false }],
    });
    expect((await statuses(org.id)).some((e) => e.status === "open")).toBe(true);
    await ingestAgentMetrics({
      agentId,
      cpuPercent: 5,
      memPercent: 5,
      mounts: [{ path: "/data", present: true }],
    });
    expect((await statuses(org.id)).every((e) => e.status === "resolved")).toBe(true);
  });
});

describe("bulk dismiss", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "test-token";
    delete process.env.DATABASE_URL;
    resetDbForTests();
  });

  async function seed(orgId: string, ageDays: number) {
    const id = newId("evt");
    await insertAlertEvent({
      id,
      orgId,
      severity: "warning",
      message: `age ${ageDays}`,
      payload: {},
    });
    const db = await getDb();
    await db.query(
      `UPDATE alert_events SET created_at = NOW() - ($2 || ' days')::interval WHERE id = $1`,
      [id, String(ageDays)],
    );
    return id;
  }

  it("dismisses only open/muted alerts older than the cutoff, per org", async () => {
    const a = await setup("bulk1@example.com");
    const b = await setup("bulk2@example.com");
    const old = await seed(a.org.id, 10);
    const fresh = await seed(a.org.id, 1);
    const otherOrg = await seed(b.org.id, 10);

    const n = await dismissAlertEventsBulk({
      orgId: a.org.id,
      dismissedBy: a.user.id,
      olderThanDays: 7,
    });
    expect(n).toBe(1);

    const rows = await listAlertEvents(a.org.id, { limit: 50 });
    expect(rows.find((r) => r.id === old)?.status).toBe("dismissed");
    expect(rows.find((r) => r.id === fresh)?.status).toBe("open");
    const other = await listAlertEvents(b.org.id, { limit: 50 });
    expect(other.find((r) => r.id === otherOrg)?.status).toBe("open");
  });

  it("olderThanDays 0 dismisses everything open", async () => {
    const a = await setup("bulk3@example.com");
    await seed(a.org.id, 0);
    await seed(a.org.id, 3);
    const n = await dismissAlertEventsBulk({
      orgId: a.org.id,
      dismissedBy: a.user.id,
      olderThanDays: 0,
    });
    expect(n).toBe(2);
  });
});
