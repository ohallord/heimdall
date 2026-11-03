import { beforeEach, describe, expect, it } from "vitest";
import { POST as webhookPost } from "@/app/api/v1/integrations/runtime/webhook/route";
import { resetAlertCooldowns } from "@/lib/alerts/cooldown";
import { getDb, resetDbForTests } from "@/lib/db/client";
import { createOrgAndAdmin } from "@/lib/db/store";
import { rotateIntegrationToken } from "@/lib/integrations/tokens";
import { listFindings } from "@/lib/security/store";
import { setCriticalFindingsToAlarms } from "@/lib/security/settings";
import { ingestRuntimeWebhook } from "./ingest";

const criticalEvent = {
  output: "Critical Write below binary dir",
  priority: "Critical",
  rule: "Write below binary dir",
  hostname: "node-b",
  output_fields: {
    "container.name": "app",
    "proc.cmdline": "cp /bin/sh /bin/evil",
  },
};

describe("runtime ingest", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "test-token";
    delete process.env.DATABASE_URL;
    resetDbForTests();
    resetAlertCooldowns();
  });

  it("upserts runtime findings and raises alarm on new critical", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "Runtime Org",
      adminName: "Admin",
      email: "runtime@example.com",
      password: "CorrectHorse1",
    });
    await setCriticalFindingsToAlarms(org.id, true);

    const first = await ingestRuntimeWebhook({
      orgId: org.id,
      body: criticalEvent,
    });
    expect(first.written).toBe(1);
    expect(first.alarmsRaised).toBe(1);

    const findings = await listFindings(org.id, { source: "runtime" });
    expect(findings).toHaveLength(1);
    expect(findings[0].external_id).toBe("Write below binary dir");
    expect(findings[0].severity).toBe("critical");

    const again = await ingestRuntimeWebhook({
      orgId: org.id,
      body: criticalEvent,
    });
    expect(again.written).toBe(1);
    expect(again.alarmsRaised).toBe(0);

    const db = await getDb();
    const alerts = await db.query(
      `SELECT COUNT(*)::int AS c FROM alert_events WHERE org_id = $1`,
      [org.id],
    );
    expect(Number(alerts.rows[0].c)).toBe(1);
  });

  it("rejects webhook without token and accepts with bearer", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "Token Org",
      adminName: "Admin",
      email: "rtoken@example.com",
      password: "CorrectHorse1",
    });
    const { token } = await rotateIntegrationToken({
      orgId: org.id,
      kind: "runtime_webhook",
    });

    const denied = await webhookPost(
      new Request("http://localhost/api/v1/integrations/runtime/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(criticalEvent),
      }),
    );
    expect(denied.status).toBe(401);

    const ok = await webhookPost(
      new Request("http://localhost/api/v1/integrations/runtime/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(criticalEvent),
      }),
    );
    expect(ok.status).toBe(200);
    const json = (await ok.json()) as {
      accepted: number;
      written: number;
    };
    expect(json.accepted).toBe(1);
    expect(json.written).toBe(1);

    const viaHeader = await webhookPost(
      new Request("http://localhost/api/v1/integrations/runtime/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-heimdall-token": token,
        },
        body: JSON.stringify({
          ...criticalEvent,
          rule: "Read sensitive file untrusted",
          priority: "Warning",
        }),
      }),
    );
    expect(viaHeader.status).toBe(200);
  });
});
