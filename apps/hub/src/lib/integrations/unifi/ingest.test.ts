import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  upsertAlertChannel,
} from "@/lib/db/store";
import { rotateIntegrationToken } from "@/lib/integrations/tokens";
import { ingestUnifiWebhook, listUnifiAlertEvents } from "./ingest";
import { POST as webhookPost } from "@/app/api/v1/integrations/unifi/webhook/route";

const fixtures = join(__dirname, "fixtures");

describe("unifi ingest", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "test-token";
    delete process.env.DATABASE_URL;
    resetDbForTests();
    resetAlertCooldowns();
  });

  it("stores network webhook and notifies on critical", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "UniFi Org",
      adminName: "Admin",
      email: "unifi@example.com",
      password: "CorrectHorse1",
    });

    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await upsertAlertChannel({
      orgId: org.id,
      kind: "slack",
      config: { url: "https://hooks.example/slack" },
    });

    const body = JSON.parse(
      readFileSync(join(fixtures, "network-wan.json"), "utf8"),
    );
    const result = await ingestUnifiWebhook({ orgId: org.id, body });
    expect(result.ok).toBe(true);
    expect(result.severity).toBe("critical");
    expect(result.notified).toBe(true);

    const events = await listUnifiAlertEvents(org.id);
    expect(events).toHaveLength(1);
    expect(events[0].message).toContain("Internet connection lost");
    const payload = JSON.parse(events[0].payload_json) as {
      device?: string;
      category?: string;
    };
    expect(payload.device).toBe("UDM-Pro");
    expect(payload.category).toBe("Internet / WAN");

    // enqueueAlert is async; give dispatch a tick then assert Slack was hit
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled(), {
      timeout: 2000,
    });
  });

  it("rejects webhook without token and accepts with bearer", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "Token Org",
      adminName: "Admin",
      email: "token@example.com",
      password: "CorrectHorse1",
    });
    const { token } = await rotateIntegrationToken({
      orgId: org.id,
      kind: "unifi_webhook",
    });

    const body = JSON.parse(
      readFileSync(join(fixtures, "protect-motion.json"), "utf8"),
    );

    const denied = await webhookPost(
      new Request("http://localhost/api/v1/integrations/unifi/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(denied.status).toBe(401);

    const ok = await webhookPost(
      new Request("http://localhost/api/v1/integrations/unifi/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      }),
    );
    expect(ok.status).toBe(200);
    const json = (await ok.json()) as { eventId: string };
    expect(json.eventId).toBeTruthy();

    const db = await getDb();
    const rows = await db.query(
      `SELECT COUNT(*)::int AS c FROM alert_events WHERE org_id = $1`,
      [org.id],
    );
    expect(Number(rows.rows[0].c)).toBe(1);
  });
});
