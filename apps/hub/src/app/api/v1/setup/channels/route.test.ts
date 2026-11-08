import { beforeEach, describe, expect, it, vi } from "vitest";

const requireSession = vi.fn();
const upsertAlertChannel = vi.fn();
const ensureDefaultThresholdRule = vi.fn();
const setSetupStep = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  requireSession: (...args: unknown[]) => requireSession(...args),
}));

vi.mock("@/lib/db/store", () => ({
  upsertAlertChannel: (...args: unknown[]) => upsertAlertChannel(...args),
  ensureDefaultThresholdRule: (...args: unknown[]) =>
    ensureDefaultThresholdRule(...args),
  setSetupStep: (...args: unknown[]) => setSetupStep(...args),
  isSetupComplete: async () => false,
}));

describe("POST /api/v1/setup/channels", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  it("saves channels when wizard session is present (setup incomplete)", async () => {
    requireSession.mockResolvedValue({
      orgId: "org_1",
      userId: "usr_1",
      role: "admin",
      isLoggedIn: true,
      mfaVerified: false,
    });
    upsertAlertChannel.mockResolvedValue({});
    ensureDefaultThresholdRule.mockResolvedValue(undefined);
    setSetupStep.mockResolvedValue(undefined);

    const { POST } = await import("./route");
    const res = await POST(
      new Request("http://127.0.0.1:43123/api/v1/setup/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slackWebhookUrl: "https://hooks.slack.test/T/B/X",
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(requireSession).toHaveBeenCalledWith({
      permission: "setup:run",
      requireMfa: false,
    });
    expect(upsertAlertChannel).toHaveBeenCalled();
    expect(setSetupStep).toHaveBeenCalledWith("agent_token");
    const body = await res.json();
    expect(body.nextStep).toBe("agent_token");
  });

  it("returns unauthorized without a session (e.g. after setup / cookie missing)", async () => {
    requireSession.mockRejectedValue(
      Object.assign(new Error("unauthorized"), { status: 401 }),
    );

    const { POST } = await import("./route");
    const res = await POST(
      new Request("http://127.0.0.1:43123/api/v1/setup/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slackWebhookUrl: "https://hooks.slack.test/T/B/X",
        }),
      }),
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
    expect(upsertAlertChannel).not.toHaveBeenCalled();
  });
});
