import { beforeEach, describe, expect, it, vi } from "vitest";

const requireSession = vi.fn();
const upsertAlertChannel = vi.fn();
vi.mock("@/lib/auth/session", () => ({ requireSession: (...a: unknown[]) => requireSession(...a) }));
vi.mock("@/lib/audit/log", () => ({ recordAudit: async () => {} }));
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

describe("setup/channels push kinds", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    requireSession.mockResolvedValue({ orgId: "o", userId: "u", role: "admin" });
    upsertAlertChannel.mockResolvedValue({});
  });

  it("saves ntfy, pushover, telegram and pagerduty configs", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      post({
        ntfy: { topic: "heimdall", token: "tk" },
        pushover: { appToken: "a", userKey: "u" },
        telegram: { botToken: "123:ABC", chatId: -1001 },
        pagerduty: { routingKey: "rk" },
      }),
    );
    expect(res.status).toBe(200);
    const kinds = upsertAlertChannel.mock.calls.map((c) => c[0].kind);
    expect(kinds).toEqual(expect.arrayContaining(["ntfy", "pushover", "telegram", "pagerduty"]));
    expect(upsertAlertChannel).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "telegram", config: { botToken: "123:ABC", chatId: -1001 } }),
    );
  });

  it("rejects an invalid config before saving anything", async () => {
    const { POST } = await import("./route");
    const res = await POST(post({ telegram: { botToken: "not-a-token", chatId: "1" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/botToken/);
    expect(upsertAlertChannel).not.toHaveBeenCalled();
  });

  it.each([
    ["ntfy", { serverUrl: "http://169.254.169.254", topic: "t" }],
    ["pushover", { appToken: "a", userKey: "u", apiBaseUrl: "http://127.0.0.1:9" }],
    ["telegram", { botToken: "1:a", chatId: "1", apiBaseUrl: "http://10.0.0.5" }],
    ["pagerduty", { routingKey: "r", apiBaseUrl: "http://[::1]" }],
  ])("refuses a private %s endpoint", async (kind, cfg) => {
    const { POST } = await import("./route");
    const res = await POST(post({ [kind]: cfg }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("blocked_host");
    expect(upsertAlertChannel).not.toHaveBeenCalled();
  });
});
