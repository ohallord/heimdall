import { beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDbForTests } from "@/lib/db/client";
import {
  createOrgAndAdmin,
  registerAgentPersistent,
} from "@/lib/db/store";
import { rotateIntegrationToken } from "@/lib/integrations/tokens";
import {
  ingestOtlpMetrics,
  listOtelMetricSamples,
  parseOtlpMetricsJson,
} from "./ingest";
import { POST as otlpPost } from "@/app/v1/metrics/route";

function sampleExport(agentId?: string) {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "otelcol" } },
            { key: "host.name", value: { stringValue: "lab-host" } },
            ...(agentId
              ? [
                  {
                    key: "heimdall.agent_id",
                    value: { stringValue: agentId },
                  },
                ]
              : []),
          ],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "system.cpu.utilization",
                unit: "1",
                gauge: {
                  dataPoints: [
                    {
                      asDouble: 0.42,
                      timeUnixNano: "1729600000000000000",
                    },
                  ],
                },
              },
              {
                name: "container.cpu.utilization",
                unit: "1",
                gauge: {
                  dataPoints: [
                    {
                      asDouble: 0.11,
                      attributes: [
                        {
                          key: "container.name",
                          value: { stringValue: "nginx" },
                        },
                      ],
                      timeUnixNano: "1729600000000000000",
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("otel ingest", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "test-token";
    delete process.env.DATABASE_URL;
    resetDbForTests();
  });

  it("parses OTLP JSON points", () => {
    const points = parseOtlpMetricsJson(sampleExport("agt_x"));
    expect(points).toHaveLength(2);
    expect(points[0].metricName).toBe("system.cpu.utilization");
    expect(points[0].value).toBe(0.42);
    expect(points[0].agentId).toBe("agt_x");
    expect(points[1].attributes["container.name"]).toBe("nginx");
  });

  it("stores points and mirrors host cpu when agent matches", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "OTEL Org",
      adminName: "Admin",
      email: "otel@example.com",
      password: "CorrectHorse1",
    });
    const registered = await registerAgentPersistent({
      token: "test-token",
      hostname: "lab-host",
      version: "0.5.0",
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const result = await ingestOtlpMetrics({
      orgId: org.id,
      body: sampleExport(registered.agent.id),
    });
    expect(result.accepted).toBe(2);
    expect(result.mirroredHosts).toBe(1);

    const samples = await listOtelMetricSamples(org.id);
    expect(samples.length).toBeGreaterThanOrEqual(2);

    const db = await getDb();
    const latest = await db.query<{ cpu_percent: number }>(
      `SELECT cpu_percent FROM agent_metric_latest WHERE agent_id = $1`,
      [registered.agent.id],
    );
    expect(latest.rows[0]?.cpu_percent).toBeCloseTo(42, 5);
  });

  it("rejects missing token and accepts bearer on /v1/metrics", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "OTLP Org",
      adminName: "Admin",
      email: "otlp@example.com",
      password: "CorrectHorse1",
    });
    const { token } = await rotateIntegrationToken({
      orgId: org.id,
      kind: "otel_ingest",
    });

    const denied = await otlpPost(
      new Request("http://localhost/v1/metrics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sampleExport()),
      }),
    );
    expect(denied.status).toBe(401);

    const ok = await otlpPost(
      new Request("http://localhost/v1/metrics", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(sampleExport()),
      }),
    );
    expect(ok.status).toBe(200);
    const json = (await ok.json()) as { accepted: number };
    expect(json.accepted).toBe(2);
  });
});
