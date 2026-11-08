import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireSession = vi.fn();
const upsertAlertChannel = vi.fn();
vi.mock("@/lib/auth/session", () => ({ requireSession: (...a: unknown[]) => requireSession(...a) }));
vi.mock("@/lib/db/store", () => ({
  upsertAlertChannel: (...a: unknown[]) => upsertAlertChannel(...a),
  ensureDefaultThresholdRule: async () => {},
  setSetupStep: async () => {},
  isSetupComplete: async () => false,
}));

const post = (body: unknown) =>
  new Request("http://hub.test/api/v1/setup/channels", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("setup/channels SMTP host validation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireSession.mockResolvedValue({ orgId: "o", userId: "u", role: "admin" });
    upsertAlertChannel.mockResolvedValue({});
  });
  afterEach(() => {
    delete process.env.HEIMDALL_ALLOW_PRIVATE_HOSTS;
  });

  it.each(["127.0.0.1", "169.254.169.254", "::1", "10.0.0.25"])(
    "rejects SMTP host %s (internal port probe) and saves nothing",
    async (host) => {
      const { POST } = await import("./route");
      const res = await POST(post({ smtp: { host, port: 25, from: "a@x.io", to: "b@x.io" } }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("blocked_host");
      expect(upsertAlertChannel).not.toHaveBeenCalled();
    },
  );

  it("accepts a LAN relay once allowlisted", async () => {
    process.env.HEIMDALL_ALLOW_PRIVATE_HOSTS = "10.0.0.25";
    const { POST } = await import("./route");
    const res = await POST(post({ smtp: { host: "10.0.0.25", port: 25, from: "a@x.io", to: "b@x.io" } }));
    expect(res.status).toBe(200);
  });
});

describe("setup/channels save-time URL validation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireSession.mockResolvedValue({ orgId: "o", userId: "u", role: "admin" });
    upsertAlertChannel.mockResolvedValue({});
  });
  afterEach(() => {
    delete process.env.HEIMDALL_ALLOW_PRIVATE_HOSTS;
  });

  it.each([
    "http://127.0.0.1/hook",
    "http://169.254.169.254/latest/meta-data",
    "http://192.168.1.10:8080/hook",
    "http://[::1]/hook",
  ])("rejects %s with blocked_host naming the allowlist env var, and saves nothing", async (url) => {
    const { POST } = await import("./route");
    const res = await POST(post({ slackWebhookUrl: url }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("blocked_host");
    expect(body.hint).toContain("HEIMDALL_ALLOW_PRIVATE_HOSTS");
    expect(upsertAlertChannel).not.toHaveBeenCalled();
  });

  it("rejects a private Twilio-compatible apiBaseUrl and a non-http scheme", async () => {
    const { POST } = await import("./route");
    const sms = { accountSid: "a", authToken: "t", from: "+1", to: "+2" };
    const r1 = await POST(post({ sms: { ...sms, apiBaseUrl: "http://10.0.0.2" } }));
    expect(r1.status).toBe(400);
    const r2 = await POST(post({ discordWebhookUrl: "ftp://example.com/x" }));
    expect(r2.status).toBe(400);
    expect((await r2.json()).error).toBe("blocked_host");
  });

  it("accepts a LAN URL once it is allowlisted", async () => {
    process.env.HEIMDALL_ALLOW_PRIVATE_HOSTS = "192.168.0.0/16";
    const { POST } = await import("./route");
    const res = await POST(post({ slackWebhookUrl: "http://192.168.1.10:8080/hook" }));
    expect(res.status).toBe(200);
    expect(upsertAlertChannel).toHaveBeenCalled();
  });

  it("accepts a public IP literal", async () => {
    const { POST } = await import("./route");
    expect((await POST(post({ slackWebhookUrl: "https://8.8.8.8/hook" }))).status).toBe(200);
  });
});
