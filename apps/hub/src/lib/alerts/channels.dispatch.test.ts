import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/http-guard/safe-fetch", async (orig) => ({
  ...(await orig<typeof import("@/lib/http-guard/safe-fetch")>()),
  guardedFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));
import { getDb, resetDbForTests } from "@/lib/db/client";
import { createOrgAndAdmin, listAlertChannels, upsertAlertChannel } from "@/lib/db/store";
import { dispatchAlert } from "./engine";

describe("new channel kinds through the store and dispatchAlert", () => {
  let orgId = "";
  beforeEach(async () => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "test-token";
    delete process.env.DATABASE_URL;
    resetDbForTests();
    const { org } = await createOrgAndAdmin({
      orgName: "Chan",
      adminName: "A",
      email: "chan@example.com",
      password: "CorrectHorse1",
    });
    orgId = org.id;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("accepts every new kind in alert_channels (CHECK constraint widened)", async () => {
    await upsertAlertChannel({ orgId, kind: "ntfy", config: { topic: "t" } });
    await upsertAlertChannel({ orgId, kind: "pushover", config: { appToken: "a", userKey: "u" } });
    await upsertAlertChannel({ orgId, kind: "telegram", config: { botToken: "1:a", chatId: "1" } });
    await upsertAlertChannel({ orgId, kind: "pagerduty", config: { routingKey: "r" } });
    const kinds = (await listAlertChannels(orgId)).map((c) => c.kind).sort();
    expect(kinds).toEqual(["ntfy", "pagerduty", "pushover", "telegram"]);
    const db = await getDb();
    await expect(
      db.query(`INSERT INTO alert_channels (id, org_id, kind) VALUES ('x', $1, 'carrier-pigeon')`, [orgId]),
    ).rejects.toThrow();
  });

  it("dispatches to ntfy and records a failing channel without throwing", async () => {
    await upsertAlertChannel({ orgId, kind: "ntfy", config: { topic: "t" } });
    await upsertAlertChannel({ orgId, kind: "telegram", config: { botToken: "1:a", chatId: "1" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: RequestInfo | URL) =>
        String(u).includes("ntfy") ? new Response("{}", { status: 200 }) : new Response(JSON.stringify({ description: "chat not found" }), { status: 400 }),
      ),
    );
    const results = await dispatchAlert(await listAlertChannels(orgId), { subject: "s", message: "m", severity: "critical" });
    expect(results.find((r) => r.channel === "ntfy")?.ok).toBe(true);
    const tg = results.find((r) => r.channel === "telegram");
    expect(tg?.ok).toBe(false);
    expect(tg?.detail).toMatch(/chat not found/);
  });
});
