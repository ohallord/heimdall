import { beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDbForTests } from "@/lib/db/client";
import { createOrgAndAdmin } from "@/lib/db/store";
import { newId } from "@/lib/ids";
import {
  deriveRedSignals,
  formatSignal,
  getServiceDetail,
  listServices,
} from "./services";

async function insertSample(input: {
  orgId: string;
  service: string | null;
  metric: string;
  value: number;
  collectedAt: Date;
  attrs?: Record<string, string>;
  unit?: string;
}) {
  const db = await getDb();
  await db.query(
    `INSERT INTO otel_metric_samples (
       id, org_id, resource_service, resource_host, agent_id,
       metric_name, unit, attributes_json, value, collected_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      newId("oms"),
      input.orgId,
      input.service,
      "host-a",
      null,
      input.metric,
      input.unit ?? null,
      JSON.stringify(input.attrs ?? {}),
      input.value,
      input.collectedAt.toISOString(),
    ],
  );
}

describe("otel services APM lite", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "test-token";
    delete process.env.DATABASE_URL;
    resetDbForTests();
  });

  it("deriveRedSignals prefers named rate/error/duration metrics", () => {
    const signals = deriveRedSignals([
      {
        id: "1",
        metric_name: "http.server.request.rate",
        unit: "1/s",
        value: 12.5,
        attributes_json: "{}",
        resource_host: null,
        collected_at: new Date().toISOString(),
      },
      {
        id: "2",
        metric_name: "http.server.request.errors",
        unit: "1",
        value: 2,
        attributes_json: "{}",
        resource_host: null,
        collected_at: new Date().toISOString(),
      },
      {
        id: "3",
        metric_name: "http.server.request.duration",
        unit: "ms",
        value: 42,
        attributes_json: "{}",
        resource_host: null,
        collected_at: new Date().toISOString(),
      },
    ]);
    expect(signals.rate).toBe(12.5);
    expect(signals.rateIsActivity).toBe(false);
    expect(signals.errors).toBe(2);
    expect(signals.duration).toBe(42);
    expect(signals.durationUnit).toBe("ms");
  });

  it("deriveRedSignals uses activity + 5xx attrs when named metrics absent", () => {
    const signals = deriveRedSignals([
      {
        id: "1",
        metric_name: "http.server.active_requests",
        unit: "1",
        value: 3,
        attributes_json: JSON.stringify({
          "http.response.status_code": "500",
        }),
        resource_host: null,
        collected_at: new Date().toISOString(),
      },
      {
        id: "2",
        metric_name: "http.server.active_requests",
        unit: "1",
        value: 1,
        attributes_json: JSON.stringify({
          "http.response.status_code": "200",
        }),
        resource_host: null,
        collected_at: new Date().toISOString(),
      },
    ]);
    expect(signals.rate).toBe(2);
    expect(signals.rateIsActivity).toBe(true);
    expect(signals.errors).toBe(1);
    expect(signals.duration).toBeNull();
  });

  it("lists services with RED summary and skips unnamed", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "APM Org",
      adminName: "Admin",
      email: "apm@example.com",
      password: "CorrectHorse1",
    });
    const now = new Date();
    await insertSample({
      orgId: org.id,
      service: "checkout",
      metric: "http.server.request.rate",
      value: 8,
      unit: "1/s",
      collectedAt: now,
    });
    await insertSample({
      orgId: org.id,
      service: "checkout",
      metric: "http.server.request.duration",
      value: 15,
      unit: "ms",
      collectedAt: new Date(now.getTime() - 1000),
    });
    await insertSample({
      orgId: org.id,
      service: "payments",
      metric: "container.cpu.utilization",
      value: 0.2,
      collectedAt: new Date(now.getTime() - 2000),
    });
    await insertSample({
      orgId: org.id,
      service: null,
      metric: "system.cpu.utilization",
      value: 0.5,
      collectedAt: now,
    });

    const list = await listServices(org.id);
    expect(list.map((s) => s.service)).toEqual(["checkout", "payments"]);
    expect(list[0]!.signals.rate).toBe(8);
    expect(list[0]!.signals.duration).toBe(15);
    expect(list[1]!.signals.rate).toBeNull();
    expect(list[1]!.sampleCount).toBe(1);
  });

  it("getServiceDetail returns series and empty-safe unknown service", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "APM Detail",
      adminName: "Admin",
      email: "apmdetail@example.com",
      password: "CorrectHorse1",
    });
    const now = new Date();
    await insertSample({
      orgId: org.id,
      service: "api",
      metric: "http.server.request.duration",
      value: 10,
      unit: "ms",
      collectedAt: new Date(now.getTime() - 2000),
    });
    await insertSample({
      orgId: org.id,
      service: "api",
      metric: "http.server.request.duration",
      value: 20,
      unit: "ms",
      collectedAt: now,
    });

    const detail = await getServiceDetail(org.id, "api");
    expect(detail.sampleCount).toBe(2);
    expect(detail.lastSeen).toBeTruthy();
    const dur = detail.series.find(
      (s) => s.metricName === "http.server.request.duration",
    );
    expect(dur?.values).toEqual([10, 20]);
    expect(dur?.latestValue).toBe(20);

    const missing = await getServiceDetail(org.id, "nope");
    expect(missing.sampleCount).toBe(0);
    expect(missing.lastSeen).toBeNull();
    expect(missing.recent).toEqual([]);
  });

  it("formatSignal renders dashes and activity", () => {
    expect(formatSignal(null)).toBe("—");
    expect(formatSignal(12, { activity: true })).toBe("12 pts");
    expect(formatSignal(42, { unit: "ms" })).toBe("42.0 ms");
  });
});
