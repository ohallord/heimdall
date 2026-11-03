import { beforeEach, describe, expect, it, vi } from "vitest";

// These tests stub global fetch with fake hosts; SSRF blocking is covered in http-guard/ and channels.ssrf.test.ts.
vi.mock("@/lib/http-guard/safe-fetch", async (orig) => ({
  ...(await orig<typeof import("@/lib/http-guard/safe-fetch")>()),
  guardedFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));
import { resetAlertCooldowns } from "@/lib/alerts/cooldown";
import { getDb, resetDbForTests } from "@/lib/db/client";
import {
  createOrgAndAdmin,
  registerAgentPersistent,
  upsertAlertChannel,
} from "@/lib/db/store";
import { setActiveCluster } from "@/lib/clusters/store";
import {
  getActiveClusterK8s,
  getLatestContainers,
  getLatestK8s,
  ingestAgentMetrics,
  isAgentOnline,
  listLatestK8s,
  listLatestMetrics,
  markContainerExitAlerts,
  samplesFromContainers,
  samplesFromKubernetes,
  samplesFromMetrics,
} from "./ingest";

describe("metrics ingest contract", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "test-token";
    delete process.env.DATABASE_URL;
    resetDbForTests();
    resetAlertCooldowns();
  });

  it("maps host samples to threshold metrics including mount_missing", () => {
    const samples = samplesFromMetrics({
      agentId: "agt_x",
      cpuPercent: 12,
      memPercent: 40,
      disks: [
        {
          mountPoint: "/",
          device: "/dev/sda1",
          totalBytes: 100,
          usedBytes: 80,
          freeBytes: 20,
          usedPercent: 80,
        },
        {
          mountPoint: "/var",
          device: "/dev/sda2",
          totalBytes: 100,
          usedBytes: 91,
          freeBytes: 9,
          usedPercent: 91,
        },
      ],
      mounts: [
        { path: "/", present: true },
        { path: "/data", present: false },
      ],
    });
    expect(samples).toEqual(
      expect.arrayContaining([
        { metric: "cpu_percent", value: 12 },
        { metric: "mem_percent", value: 40 },
        { metric: "disk_percent", value: 80 },
        { metric: "disk_percent:/var", value: 91 },
        { metric: "mount_missing", value: 1 },
        { metric: "mount_missing:/data", value: 1 },
      ]),
    );
  });

  it("records warn-only events for yellow disk without channel notify", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "Band Org",
      adminName: "Admin",
      email: "band@example.com",
      password: "CorrectHorse1",
    });

    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await upsertAlertChannel({
      orgId: org.id,
      kind: "slack",
      config: { url: "https://hooks.example/slack" },
    });

    const registered = await registerAgentPersistent({
      token: "test-token",
      hostname: "edge-bands",
      version: "0.5.0",
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const result = await ingestAgentMetrics({
      agentId: registered.agent.id,
      cpuPercent: 10,
      memPercent: 20,
      disks: [
        {
          mountPoint: "/",
          device: "/dev/sda1",
          totalBytes: 1000,
          usedBytes: 100,
          freeBytes: 900,
          usedPercent: 10,
        },
        {
          mountPoint: "/var",
          device: "/dev/sdb1",
          totalBytes: 1000,
          usedBytes: 920,
          freeBytes: 80,
          usedPercent: 92,
        },
      ],
      mounts: [
        { path: "/", present: true, usedPercent: 10 },
        { path: "/var", present: true, usedPercent: 92 },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alertsFired).toBeGreaterThanOrEqual(1);
    expect(fetchMock).not.toHaveBeenCalled();

    const db = await getDb();
    const events = await db.query<{ severity: string; message: string }>(
      `SELECT severity, message FROM alert_events WHERE org_id = $1 ORDER BY created_at DESC`,
      [org.id],
    );
    expect(events.rows.some((e) => e.message.includes("disk_percent:/var"))).toBe(
      true,
    );
    expect(events.rows.every((e) => e.severity === "warning")).toBe(true);

    vi.unstubAllGlobals();
  });

  it("stores metrics, updates lastSeen, and fires mount-down alerts", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "Metrics Org",
      adminName: "Admin",
      email: "metrics@example.com",
      password: "CorrectHorse1",
    });

    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await upsertAlertChannel({
      orgId: org.id,
      kind: "slack",
      config: { url: "https://hooks.example/slack" },
    });

    const registered = await registerAgentPersistent({
      token: "test-token",
      hostname: "edge-metrics",
      version: "0.2.0",
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const result = await ingestAgentMetrics({
      agentId: registered.agent.id,
      cpuPercent: 11,
      memPercent: 22,
      load1: 0.5,
      disks: [
        {
          mountPoint: "/",
          device: "/dev/sda1",
          totalBytes: 1000,
          usedBytes: 200,
          freeBytes: 800,
          usedPercent: 20,
        },
      ],
      mounts: [
        { path: "/", present: true, usedPercent: 20 },
        { path: "/var", present: false },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alertsFired).toBeGreaterThanOrEqual(1);
    expect(isAgentOnline(result.lastSeenAt)).toBe(true);
    expect(fetchMock).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("fires one Mount missing alert per missing path, naming the path", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "Mount Path Org",
      adminName: "Admin",
      email: "mountpath@example.com",
      password: "CorrectHorse1",
    });
    const registered = await registerAgentPersistent({
      token: "test-token",
      hostname: "edge-mountpath",
      version: "0.2.0",
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const result = await ingestAgentMetrics({
      agentId: registered.agent.id,
      cpuPercent: 1,
      memPercent: 1,
      mounts: [
        { path: "/", present: true, usedPercent: 20 },
        { path: "/mnt/WorkOutVideos", present: false },
        { path: "/mnt/Movies", present: false },
      ],
    });
    expect(result.ok).toBe(true);

    const db = await getDb();
    const events = await db.query<{ message: string; payload_json: unknown }>(
      `SELECT message, payload_json FROM alert_events WHERE org_id = $1`,
      [org.id],
    );
    const mountEvents = events.rows.filter((e) => e.message.startsWith("mount_missing"));
    expect(mountEvents.map((e) => e.message.split(" ")[0]).sort()).toEqual([
      "mount_missing:/mnt/Movies",
      "mount_missing:/mnt/WorkOutVideos",
    ]);
    for (const e of mountEvents) {
      const raw = e.payload_json;
      const payload = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
        mountPath?: string;
      };
      expect(e.message).toContain(payload.mountPath ?? "<no mountPath>");
    }
  });

  it("rejects unknown agents", async () => {
    const result = await ingestAgentMetrics({
      agentId: "agt_missing",
      cpuPercent: 1,
      memPercent: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });

  it("maps container exit/OOM/restart-loop samples", () => {
    const samples = samplesFromContainers([
      {
        id: "1",
        name: "api",
        image: "api:1",
        state: "running",
        status: "Up",
        restartCount: 0,
        memPercent: 95,
      },
      {
        id: "2",
        name: "worker",
        image: "worker:1",
        state: "exited",
        status: "Exited",
        restartCount: 5,
        oomKilled: true,
        restartLoop: true,
        exitCode: 137,
        exitAlert: true,
      },
      {
        id: "3",
        name: "old-job",
        image: "job:1",
        state: "exited",
        status: "Exited (1) 3 months ago",
        restartCount: 0,
        exitCode: 1,
      },
    ]);
    expect(samples).not.toContainEqual({ metric: "container_exited:old-job", value: 1 });
    expect(samples).not.toContainEqual({ metric: "container_exited", value: 1 });
    expect(samples).toEqual(
      expect.arrayContaining([
        { metric: "container_mem_limit_pct", value: 95 },
        { metric: "container_exited:worker", value: 1 },
        { metric: "container_oom", value: 1 },
        { metric: "container_restart_loop", value: 1 },
      ]),
    );
  });

  describe("markContainerExitAlerts", () => {
    const base = { image: "img:1", status: "", restartCount: 0 };
    const prevAt = "2026-11-01T10:00:00.000Z";

    it("ignores everything when there is no previous snapshot", () => {
      const out = markContainerExitAlerts(
        [{ ...base, id: "a", name: "a", state: "exited", exitCode: 137 }],
        null,
      );
      expect(out[0].exitAlert).toBeUndefined();
    });

    it("flags running → exited with a non-zero code", () => {
      const out = markContainerExitAlerts(
        [{ ...base, id: "a", name: "a", state: "exited", exitCode: 1 }],
        { collectedAt: prevAt, containers: [{ ...base, id: "a", name: "a", state: "running" }] },
      );
      expect(out[0].exitAlert).toBe(true);
    });

    it("does not flag clean exits or long-stopped containers", () => {
      const out = markContainerExitAlerts(
        [
          { ...base, id: "a", name: "clean", state: "exited", exitCode: 0 },
          {
            ...base,
            id: "b",
            name: "parked",
            state: "exited",
            exitCode: 137,
            finishedAt: "2026-03-01T00:00:00Z",
          },
        ],
        {
          collectedAt: prevAt,
          containers: [
            { ...base, id: "a", name: "clean", state: "running" },
            { ...base, id: "b", name: "parked", state: "exited", exitCode: 137 },
          ],
        },
      );
      expect(out.map((c) => c.exitAlert)).toEqual([undefined, undefined]);
    });

    it("flags a container that crashed between scrapes and carries the flag forward", () => {
      const crashed = markContainerExitAlerts(
        [
          {
            ...base,
            id: "a",
            name: "new",
            state: "exited",
            exitCode: 2,
            finishedAt: "2026-11-01T10:00:05Z",
          },
        ],
        { collectedAt: prevAt, containers: [] },
      );
      expect(crashed[0].exitAlert).toBe(true);
      const still = markContainerExitAlerts(
        [{ ...base, id: "a", name: "new", state: "exited", exitCode: 2 }],
        { collectedAt: "2026-11-01T10:05:00.000Z", containers: crashed },
      );
      expect(still[0].exitAlert).toBe(true);
    });

    it("drops the flag once the container runs again and strips agent-sent flags", () => {
      const out = markContainerExitAlerts(
        [{ ...base, id: "a", name: "a", state: "running", exitAlert: true }],
        {
          collectedAt: prevAt,
          containers: [{ ...base, id: "a", name: "a", state: "exited", exitAlert: true }],
        },
      );
      expect(out[0].exitAlert).toBeUndefined();
    });
  });

  it("alerts only on containers that stop while monitored, and resolves on restart", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "Exit Org",
      adminName: "Admin",
      email: "exit@example.com",
      password: "CorrectHorse1",
    });
    const registered = await registerAgentPersistent({
      token: "test-token",
      hostname: "media",
      version: "0.3.0",
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const agentId = registered.agent.id;
    const ctr = (name: string, state: string, exitCode?: number) => ({
      id: name,
      name,
      image: `${name}:latest`,
      state,
      status: state,
      restartCount: 0,
      ...(exitCode != null ? { exitCode } : {}),
    });
    const send = (containers: ReturnType<typeof ctr>[]) =>
      ingestAgentMetrics({
        agentId,
        cpuPercent: 5,
        memPercent: 5,
        containerRuntime: "docker",
        containers,
      });
    const exitEvents = async () =>
      (
        await (await getDb()).query<{ message: string; status: string; payload_json: string }>(
          `SELECT message, status, payload_json FROM alert_events
           WHERE org_id = $1 AND message LIKE 'container_exited%' ORDER BY created_at`,
          [org.id],
        )
      ).rows;

    // First snapshot: long-dead leftovers must not alert.
    await send([ctr("jellyfin", "exited", 0), ctr("cards", "exited", 137), ctr("app", "running")]);
    expect(await exitEvents()).toHaveLength(0);

    // app crashes; leftovers still quiet.
    await send([ctr("jellyfin", "exited", 0), ctr("cards", "exited", 137), ctr("app", "exited", 1)]);
    let events = await exitEvents();
    expect(events).toHaveLength(1);
    expect(events[0].message).toContain("container_exited:app");
    expect(JSON.parse(events[0].payload_json).container).toEqual({
      name: "app",
      image: "app:latest",
      exitCode: 1,
    });

    // Still down: alert stays open (not resolved by the next scrape).
    await send([ctr("cards", "exited", 137), ctr("app", "exited", 1)]);
    events = await exitEvents();
    expect(events.every((e) => e.status === "open")).toBe(true);

    // Back up: resolved.
    await send([ctr("cards", "exited", 137), ctr("app", "running")]);
    events = await exitEvents();
    expect(events.every((e) => e.status === "resolved")).toBe(true);
  });

  it("persists containers and fires exit/OOM alerts", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "Ctr Org",
      adminName: "Admin",
      email: "ctr@example.com",
      password: "CorrectHorse1",
    });

    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await upsertAlertChannel({
      orgId: org.id,
      kind: "slack",
      config: { url: "https://hooks.example/slack" },
    });

    const registered = await registerAgentPersistent({
      token: "test-token",
      hostname: "edge-ctr",
      version: "0.3.0",
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const result = await ingestAgentMetrics({
      agentId: registered.agent.id,
      cpuPercent: 5,
      memPercent: 10,
      containerRuntime: "docker",
      containers: [
        {
          id: "deadbeef",
          name: "worker",
          image: "worker:1",
          state: "exited",
          status: "Exited (137)",
          restartCount: 4,
          oomKilled: true,
          restartLoop: true,
          exitCode: 137,
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alertsFired).toBeGreaterThanOrEqual(1);

    const stored = await getLatestContainers(registered.agent.id);
    expect(stored?.runtime).toBe("docker");
    expect(stored?.containers_json).toContain("worker");
    expect(fetchMock).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("maps kubernetes node/pod/deployment health samples", () => {
    const samples = samplesFromKubernetes({
      clusterId: "default",
      enabled: true,
      apiServerReachable: false,
      nodesTotal: 3,
      nodesReady: 2,
      podsPending: 1,
      podsCrashLoop: 2,
      deploymentsTotal: 4,
      deploymentsUnhealthy: 1,
    });
    expect(samples).toEqual(
      expect.arrayContaining([
        { metric: "k8s_apiserver_unreachable", value: 1 },
        { metric: "k8s_node_not_ready", value: 1 },
        { metric: "k8s_pod_pending", value: 1 },
        { metric: "k8s_pod_crashloop", value: 2 },
        { metric: "k8s_deployment_unhealthy", value: 1 },
      ]),
    );
  });

  it("skips k8s unreachable alerts when collection is disabled", () => {
    const samples = samplesFromKubernetes({
      clusterId: "default",
      enabled: false,
      apiServerReachable: false,
      nodesTotal: 0,
      nodesReady: 0,
      podsPending: 0,
      podsCrashLoop: 0,
      deploymentsTotal: 0,
      deploymentsUnhealthy: 0,
    });
    expect(samples).toEqual([]);
  });

  it("persists kubernetes snapshot, reserves cluster_id, and fires alerts", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "K8s Org",
      adminName: "Admin",
      email: "k8s@example.com",
      password: "CorrectHorse1",
    });

    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await upsertAlertChannel({
      orgId: org.id,
      kind: "slack",
      config: { url: "https://hooks.example/slack" },
    });

    const registered = await registerAgentPersistent({
      token: "test-token",
      hostname: "edge-k8s",
      version: "0.4.0",
      clusterId: "default",
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const result = await ingestAgentMetrics({
      agentId: registered.agent.id,
      clusterId: "default",
      cpuPercent: 5,
      memPercent: 10,
      kubernetes: {
        clusterId: "default",
        apiServerReachable: true,
        apiServerLatencyMs: 12,
        nodesTotal: 2,
        nodesReady: 1,
        nodesNotReady: [{ name: "node-b", ready: false, reason: "NotReady" }],
        podsPending: 1,
        podsCrashLoop: 0,
        podProblems: [
          {
            namespace: "default",
            name: "web-0",
            phase: "Pending",
            problem: "pending",
            restarts: 0,
          },
        ],
        deploymentsTotal: 2,
        deploymentsUnhealthy: 1,
        deployments: [
          {
            namespace: "default",
            name: "web",
            desired: 2,
            ready: 1,
            available: 1,
            healthy: false,
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alertsFired).toBeGreaterThanOrEqual(1);
    expect(result.agent.cluster_id).toBe("default");

    const stored = await getLatestK8s(registered.agent.id);
    expect(stored?.cluster_id).toBe("default");
    expect(stored?.summary_json).toContain("node-b");

    const active = await getActiveClusterK8s(org.id);
    expect(active?.clusterId).toBe("default");
    expect(active?.summary.nodesReady).toBe(1);
    expect(fetchMock).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("lists fleet metrics/k8s via agent org after Bootstrap→wizard move", async () => {
    const { org: bootstrap } = await createOrgAndAdmin({
      orgName: "Bootstrap",
      adminName: "Boot",
      email: "boot@example.com",
      password: "CorrectHorse1",
    });
    const registered = await registerAgentPersistent({
      token: "test-token",
      hostname: "k8s-homelab-01",
      version: "0.4.0",
      clusterId: "homelab",
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const ingest1 = await ingestAgentMetrics({
      agentId: registered.agent.id,
      clusterId: "homelab",
      cpuPercent: 11,
      memPercent: 22,
      mounts: [{ path: "/host", present: true, usedPercent: 40 }],
      kubernetes: {
        enabled: true,
        clusterId: "homelab",
        apiServerReachable: true,
        apiServerLatencyMs: 5,
        nodesTotal: 1,
        nodesReady: 1,
        podsPending: 0,
        podsCrashLoop: 0,
        podsTotal: 1,
        pods: [
          {
            namespace: "heimdall",
            name: "heimdall-hub-0",
            phase: "Running",
            ready: "1/1",
            restarts: 0,
            healthy: true,
          },
        ],
        deploymentsTotal: 1,
        deploymentsUnhealthy: 0,
      },
    });
    expect(ingest1.ok).toBe(true);

    const { org: wizard } = await createOrgAndAdmin({
      orgName: "Lab",
      adminName: "Dan",
      email: "dan@example.com",
      password: "CorrectHorse1",
    });

    const db = await getDb();
    // Simulate surgical org adopt: agent moved, latest rows still on Bootstrap org_id.
    await db.query(`UPDATE agents SET org_id = $1 WHERE id = $2`, [
      wizard.id,
      registered.agent.id,
    ]);
    await setActiveCluster(wizard.id, "homelab");

    const staleK8s = await getLatestK8s(registered.agent.id);
    expect(staleK8s?.org_id).toBe(bootstrap.id);

    // Fleet queries must join via agents.org_id (not stale latest.org_id).
    const metrics = await listLatestMetrics(wizard.id);
    expect(metrics).toHaveLength(1);
    expect(Number(metrics[0].cpu_percent)).toBe(11);

    const k8sRows = await listLatestK8s(wizard.id);
    expect(k8sRows).toHaveLength(1);

    const active = await getActiveClusterK8s(wizard.id);
    expect(active?.clusterId).toBe("homelab");
    expect(active?.summary.enabled).toBe(true);
    expect(active?.summary.pods?.[0]?.name).toBe("heimdall-hub-0");

    // Next ingest repairs latest.org_id.
    const ingest2 = await ingestAgentMetrics({
      agentId: registered.agent.id,
      clusterId: "homelab",
      cpuPercent: 12,
      memPercent: 23,
      kubernetes: {
        enabled: true,
        clusterId: "homelab",
        apiServerReachable: true,
        nodesTotal: 1,
        nodesReady: 1,
        podsPending: 0,
        podsCrashLoop: 0,
        deploymentsTotal: 0,
        deploymentsUnhealthy: 0,
      },
    });
    expect(ingest2.ok).toBe(true);
    const repaired = await getLatestK8s(registered.agent.id);
    expect(repaired?.org_id).toBe(wizard.id);
  });

  it("prefers enabled k8s sample over disabled stub for active cluster", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "Multi",
      adminName: "Admin",
      email: "multi@example.com",
      password: "CorrectHorse1",
    });
    await setActiveCluster(org.id, "homelab");

    const compose = await registerAgentPersistent({
      token: "test-token",
      hostname: "compose-agent-01",
      version: "0.4.0",
      clusterId: "homelab",
    });
    const k8sAgent = await registerAgentPersistent({
      token: "test-token",
      hostname: "k8s-homelab-01",
      version: "0.4.0",
      clusterId: "homelab",
    });
    expect(compose.ok && k8sAgent.ok).toBe(true);
    if (!compose.ok || !k8sAgent.ok) return;

    await ingestAgentMetrics({
      agentId: compose.agent.id,
      clusterId: "homelab",
      cpuPercent: 1,
      memPercent: 1,
      kubernetes: {
        enabled: false,
        clusterId: "homelab",
        apiServerReachable: false,
        nodesTotal: 0,
        nodesReady: 0,
        podsPending: 0,
        podsCrashLoop: 0,
        deploymentsTotal: 0,
        deploymentsUnhealthy: 0,
      },
    });
    await ingestAgentMetrics({
      agentId: k8sAgent.agent.id,
      clusterId: "homelab",
      cpuPercent: 2,
      memPercent: 2,
      kubernetes: {
        enabled: true,
        clusterId: "homelab",
        apiServerReachable: true,
        apiServerLatencyMs: 8,
        nodesTotal: 1,
        nodesReady: 1,
        podsPending: 0,
        podsCrashLoop: 0,
        deploymentsTotal: 1,
        deploymentsUnhealthy: 0,
      },
    });

    const active = await getActiveClusterK8s(org.id);
    expect(active?.summary.enabled).toBe(true);
    expect(active?.summary.apiServerReachable).toBe(true);
    expect(active?.summary.nodesReady).toBe(1);
  });
});
