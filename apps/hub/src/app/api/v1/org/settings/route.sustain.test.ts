import { beforeEach, describe, expect, it, vi } from "vitest";

const requireSession = vi.fn();
const setAlertSustainSeconds = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  requireSession: (...a: unknown[]) => requireSession(...a),
}));
vi.mock("@/lib/alerts/sustain-settings", () => ({
  MAX_ALERT_SUSTAIN_SECONDS: 3600,
  getAlertSustainSeconds: async () => 120,
  setAlertSustainSeconds: (...a: unknown[]) => setAlertSustainSeconds(...a),
}));
vi.mock("@/lib/metrics/retention", () => ({
  getMetricsRetentionDays: async () => 60,
  getLogsRetentionDays: async () => 60,
  getTracesRetentionDays: async () => 7,
  setMetricsRetentionDays: async () => 60,
  setLogsRetentionDays: async () => 60,
  setTracesRetentionDays: async () => 7,
}));
vi.mock("@/lib/security/settings", () => ({
  getCriticalFindingsToAlarms: async () => true,
  setCriticalFindingsToAlarms: async () => true,
}));

function patch(body: unknown) {
  return new Request("http://127.0.0.1:43123/api/v1/org/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/v1/org/settings alertSustainSeconds", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    requireSession.mockResolvedValue({ orgId: "org_1", role: "operator" });
    setAlertSustainSeconds.mockImplementation(async (_o: string, n: number) => n);
  });

  it("saves a valid window and returns it", async () => {
    const { PATCH } = await import("./route");
    const res = await PATCH(patch({ alertSustainSeconds: 300 }));
    expect(res.status).toBe(200);
    expect(setAlertSustainSeconds).toHaveBeenCalledWith("org_1", 300);
    expect((await res.json()).alertSustainSeconds).toBe(300);
  });

  it("accepts 0 and rejects negative, fractional-nonsense and oversized values", async () => {
    const { PATCH } = await import("./route");
    expect((await PATCH(patch({ alertSustainSeconds: 0 }))).status).toBe(200);
    for (const bad of [-1, 3601, "60", null]) {
      const res = await PATCH(patch({ alertSustainSeconds: bad }));
      expect(res.status, String(bad)).toBe(400);
    }
  });

  it("GET reports the current window", async () => {
    requireSession.mockResolvedValue({ orgId: "org_1", role: "viewer" });
    const { GET } = await import("./route");
    expect((await (await GET()).json()).alertSustainSeconds).toBe(120);
  });
});
