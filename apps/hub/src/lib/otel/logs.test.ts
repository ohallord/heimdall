import { beforeEach, describe, expect, it } from "vitest";
import { resetAlertCooldowns } from "@/lib/alerts/cooldown";
import { setAlertsPaused } from "@/lib/alerts/pause";
import { resetDbForTests } from "@/lib/db/client";
import {
  createOrgAndAdmin,
  registerAgentPersistent,
} from "@/lib/db/store";
import { rotateIntegrationToken } from "@/lib/integrations/tokens";
import { searchLogEvents } from "@/lib/logs/ingest";
import { ingestOtlpLogs, parseOtlpLogsJson } from "./logs";
import { POST as otlpLogsPost } from "@/app/v1/logs/route";

function sampleExport(agentId?: string) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "sshd" } },
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
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "1729600000000000000",
                body: {
                  stringValue:
                    "Failed password for root from 203.0.113.50 port 43321 ssh2",
                },
                attributes: [
                  {
                    key: "_SYSTEMD_UNIT",
                    value: { stringValue: "sshd.service" },
                  },
                ],
              },
              {
                timeUnixNano: "1729600001000000000",
                body: {
                  stringValue: "Accepted publickey for deploy from 10.0.0.8",
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("otel logs ingest", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "test-token";
    delete process.env.DATABASE_URL;
    resetDbForTests();
    resetAlertCooldowns();
    setAlertsPaused(false);
  });

  it("parses OTLP JSON log records", () => {
    const lines = parseOtlpLogsJson(sampleExport("agt_x"));
    expect(lines).toHaveLength(2);
    expect(lines[0].source).toBe("sshd.service");
    expect(lines[0].agentId).toBe("agt_x");
    expect(lines[0].line).toContain("Failed password");
    expect(lines[1].source).toBe("sshd");
  });

  it("unwraps journald map bodies into MESSAGE and unit source", () => {
    // Shape the otelcol-contrib journald receiver actually sends (seen on a real host).
    const kv = (key: string, v: string) => ({ key, value: { stringValue: v } });
    const lines = parseOtlpLogsJson({
      resourceLogs: [
        {
          resource: { attributes: [kv("service.name", "heimdall-host")] },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1730000000000000000",
                  body: {
                    kvlistValue: {
                      values: [
                        kv("__CURSOR", "s=abc;i=1"),
                        kv("_HOSTNAME", "host01"),
                        kv("PRIORITY", "6"),
                        kv("_SYSTEMD_UNIT", "ssh.service"),
                        kv("SYSLOG_IDENTIFIER", "sshd"),
                        kv("MESSAGE", "Failed password for root from 10.0.0.9 port 22 ssh2"),
                      ],
                    },
                  },
                },
                {
                  body: {
                    kvlistValue: {
                      values: [kv("SYSLOG_IDENTIFIER", "kernel"), kv("MESSAGE", "usb 1-1: new device")],
                    },
                  },
                },
                { body: { kvlistValue: { values: [kv("__CURSOR", "s=abc;i=3")] } } },
                { body: { kvlistValue: { values: [kv("level", "info"), kv("msg_id", "42")] } } },
              ],
            },
          ],
        },
      ],
    });
    expect(lines).toHaveLength(3);
    expect(lines[2].line).toContain('"msg_id"');
    expect(lines[0].line).toBe("Failed password for root from 10.0.0.9 port 22 ssh2");
    expect(lines[0].source).toBe("ssh.service");
    expect(lines[1].line).toBe("usb 1-1: new device");
    expect(lines[1].source).toBe("kernel");
  });

  it("stores lines with agent binding and rule matches", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "OTEL Logs Org",
      adminName: "Admin",
      email: "otellogs@example.com",
      password: "CorrectHorse1",
    });
    const registered = await registerAgentPersistent({
      token: "test-token",
      hostname: "lab-host",
      version: "0.5.0",
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const result = await ingestOtlpLogs({
      orgId: org.id,
      body: sampleExport(registered.agent.id),
    });
    expect(result.accepted).toBe(2);
    expect(result.matches).toBeGreaterThanOrEqual(1);

    const events = await searchLogEvents({ orgId: org.id });
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.agent_id === registered.agent.id)).toBe(true);
    expect(events.some((e) => e.source === "sshd.service")).toBe(true);
  });

  it("rejects missing token and accepts bearer on /v1/logs", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "OTLP Logs Route",
      adminName: "Admin",
      email: "otlproute@example.com",
      password: "CorrectHorse1",
    });
    const { token } = await rotateIntegrationToken({
      orgId: org.id,
      kind: "otel_ingest",
    });

    const denied = await otlpLogsPost(
      new Request("http://localhost/v1/logs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sampleExport()),
      }),
    );
    expect(denied.status).toBe(401);

    const proto = await otlpLogsPost(
      new Request("http://localhost/v1/logs", {
        method: "POST",
        headers: {
          "content-type": "application/x-protobuf",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(sampleExport()),
      }),
    );
    expect(proto.status).toBe(415);

    const ok = await otlpLogsPost(
      new Request("http://localhost/v1/logs", {
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
