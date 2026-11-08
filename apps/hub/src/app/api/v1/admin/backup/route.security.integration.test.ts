import { beforeEach, describe, expect, it, vi } from "vitest";

const session: Record<string, unknown> = { save: vi.fn(async () => {}) };
vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("iron-session", () => ({ getIronSession: async () => session }));

import { resetDbForTests } from "@/lib/db/client";
import { createOrgAndAdmin, upsertAlertChannel } from "@/lib/db/store";
import { listOidcProviders } from "@/lib/oidc/store";
import { GET, POST } from "./route";

const post = (backup: unknown) =>
  new Request("http://hub.test/api/v1/admin/backup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ backup }),
  });

describe("backup restore/export hardening", () => {
  let orgId: string;
  beforeEach(async () => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    delete process.env.DATABASE_URL;
    delete process.env.HEIMDALL_ALLOW_PRIVATE_HOSTS;
    resetDbForTests();
    const { org, user } = await createOrgAndAdmin({
      orgName: "Ops", adminName: "A", email: "a@example.com", password: "Correct-Horse-Battery-9",
    });
    orgId = org.id;
    Object.assign(session, { isLoggedIn: true, userId: user.id, orgId, role: "admin", mfaVerified: true });
  });

  it("rejects unknown channel kinds instead of casting them through", async () => {
    const res = await POST(post({ version: 1, alertChannels: [{ kind: "exec", config: {} }] }));
    expect(res.status).toBe(400);
  });

  it("rejects an internal OIDC issuer or webhook (SSRF) on restore", async () => {
    const oidc = await POST(post({
      version: 1,
      oidcProviders: [{ name: "x", issuer: "http://169.254.169.254/", clientId: "c", clientSecret: "s" }],
    }));
    expect(oidc.status).toBe(400);
    expect((await oidc.json()).error).toBe("blocked_host");
    const hook = await POST(post({ version: 1, alertChannels: [{ kind: "slack", config: { url: "http://127.0.0.1:6379/" } }] }));
    expect(hook.status).toBe(400);
  });

  it("restores OIDC providers disabled so an admin reviews them first", async () => {
    const res = await POST(post({
      version: 1,
      oidcProviders: [{ name: "idp", issuer: "https://8.8.8.8/", clientId: "c", clientSecret: "s", enabled: true }],
    }));
    expect(res.status).toBe(200);
    const providers = await listOidcProviders(orgId);
    expect(providers).toHaveLength(1);
    expect(providers[0].enabled).toBe(false);
  });

  it("redacts webhook URLs and nested secrets in the default export", async () => {
    await upsertAlertChannel({
      orgId, kind: "slack", config: { url: "https://hooks.slack.com/services/T000/B000/XXXX", nested: { apiKey: "k" } },
    });
    const res = await GET(new Request("http://hub.test/api/v1/admin/backup"));
    const text = await res.text();
    expect(text).not.toContain("hooks.slack.com/services");
    expect(text).not.toContain('"apiKey":"k"');
  });
});
