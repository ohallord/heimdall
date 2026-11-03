import { beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "@/lib/db/client";
import {
  createOrgAndAdmin,
  registerAgentPersistent,
} from "@/lib/db/store";
import { ingestAgentMetrics } from "./ingest";
import { chooseStepSeconds, queryMetricHistory } from "./history";
import {
  getMetricsRetentionDays,
  resetPurgeCooldowns,
  setMetricsRetentionDays,
} from "./retention";

describe("metric history helpers", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "test-token";
    delete process.env.DATABASE_URL;
    resetDbForTests();
    resetPurgeCooldowns();
  });

  it("chooses step from window size", () => {
    const now = Date.UTC(2026, 0, 15);
    expect(chooseStepSeconds(now - 3600_000, now, 2000)).toBe(10);
    // 3d / 60s needs ~4320 pts — stay at 60s when maxPoints allows it
    expect(chooseStepSeconds(now - 3 * 86400_000, now, 5000)).toBe(60);
    expect(chooseStepSeconds(now - 14 * 86400_000, now, 5000)).toBe(300);
    // Widen when maxPoints would otherwise be exceeded
    expect(chooseStepSeconds(now - 3 * 86400_000, now, 2000)).toBe(180);
  });

  it("returns cpu history points and clamps retention setting", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "Hist Org",
      adminName: "Admin",
      email: "hist@example.com",
      password: "CorrectHorse1",
    });
    expect(await getMetricsRetentionDays(org.id)).toBe(60);
    expect(await setMetricsRetentionDays(org.id, 90)).toBe(90);
    expect(await setMetricsRetentionDays(org.id, 10)).toBe(30);
    expect(await setMetricsRetentionDays(org.id, 999)).toBe(365);

    const registered = await registerAgentPersistent({
      token: "test-token",
      hostname: "hist-host",
      version: "0.5.0",
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const base = Date.now() - 60_000;
    for (let i = 0; i < 6; i++) {
      const r = await ingestAgentMetrics({
        agentId: registered.agent.id,
        collectedAt: new Date(base + i * 10_000).toISOString(),
        cpuPercent: 10 + i,
        memPercent: 40,
        disks: [
          {
            mountPoint: "/",
            device: "/dev/sda1",
            totalBytes: 100,
            usedBytes: 50 + i,
            freeBytes: 50 - i,
            usedPercent: 50 + i,
          },
        ],
      });
      expect(r.ok).toBe(true);
    }

    const hist = await queryMetricHistory({
      orgId: org.id,
      agentId: registered.agent.id,
      metric: "cpu",
      from: new Date(base - 5_000),
      to: new Date(base + 120_000),
    });
    expect("error" in hist).toBe(false);
    if ("error" in hist) return;
    expect(hist.points.length).toBeGreaterThan(0);
    expect(hist.metric).toBe("cpu");

    const disk = await queryMetricHistory({
      orgId: org.id,
      agentId: registered.agent.id,
      metric: "disk",
      mount: "/",
      from: new Date(base - 5_000),
      to: new Date(base + 120_000),
    });
    expect("error" in disk).toBe(false);
    if ("error" in disk) return;
    expect(disk.points.length).toBeGreaterThan(0);
  });
});
