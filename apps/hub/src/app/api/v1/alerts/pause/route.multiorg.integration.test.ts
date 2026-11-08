import { beforeEach, describe, expect, it, vi } from "vitest";

const session: Record<string, unknown> = { save: vi.fn(async () => {}) };
vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("iron-session", () => ({ getIronSession: async () => session }));

import { resetDbForTests } from "@/lib/db/client";
import { createOrgAndAdmin, ensureBootstrapOrg } from "@/lib/db/store";
import { areAlertsPaused, setAlertsPaused } from "@/lib/alerts/pause";
import { POST } from "./route";

const post = (paused: boolean) =>
  new Request("http://hub.test/api/v1/alerts/pause", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paused }),
  });

describe("hub-wide alert pause on a multi-org hub", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    delete process.env.DATABASE_URL;
    resetDbForTests();
    setAlertsPaused(false);
  });

  it("an admin of a second org cannot silence every org", async () => {
    const first = await createOrgAndAdmin({ orgName: "Main", adminName: "A", email: "a@example.com", password: "Correct-Horse-Battery-9" });
    expect((await ensureBootstrapOrg()).id).toBe(first.org.id);
    const second = await createOrgAndAdmin({ orgName: "Tenant", adminName: "B", email: "b@example.com", password: "Correct-Horse-Battery-9" });
    Object.assign(session, { isLoggedIn: true, userId: second.user.id, orgId: second.org.id, role: "admin", mfaVerified: true });
    expect((await POST(post(true))).status).toBe(403);
    expect(areAlertsPaused()).toBe(false);
    Object.assign(session, { userId: first.user.id, orgId: first.org.id });
    expect((await POST(post(true))).status).toBe(200);
    expect(areAlertsPaused()).toBe(true);
  });
});
