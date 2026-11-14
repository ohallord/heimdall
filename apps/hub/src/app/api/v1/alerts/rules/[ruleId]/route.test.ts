import { beforeEach, describe, expect, it, vi } from "vitest";

const requireSession = vi.fn();
const updateAlertRuleThresholds = vi.fn();
const recordAudit = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  requireSession: (...a: unknown[]) => requireSession(...a),
}));
vi.mock("@/lib/db/store", () => ({
  updateAlertRuleThresholds: (...a: unknown[]) => updateAlertRuleThresholds(...a),
}));
vi.mock("@/lib/audit/log", () => ({
  recordAudit: (...a: unknown[]) => recordAudit(...a),
}));

const ORIGIN = "http://127.0.0.1:43123";
const session = { orgId: "org_1", userId: "u1", email: "o@x.io", role: "operator" };
const row = {
  id: "r1",
  name: "High CPU",
  metric: "cpu_percent",
  operator: "gte",
  threshold: 95,
  warn_threshold: 85,
  alarm_threshold: 95,
  enabled: true,
  sustain_seconds: 30,
};

function patch(body: unknown) {
  return new Request(`${ORIGIN}/api/v1/alerts/rules/r1`, {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });
}
const ctx = { params: Promise.resolve({ ruleId: "r1" }) };

describe("PATCH /api/v1/alerts/rules/:ruleId sustainSeconds", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    process.env.HEIMDALL_PUBLIC_URL = ORIGIN;
    requireSession.mockResolvedValue(session);
    updateAlertRuleThresholds.mockResolvedValue(row);
    recordAudit.mockResolvedValue(undefined);
  });

  it("saves a window, returns it and records an audit entry", async () => {
    const { PATCH } = await import("./route");
    const res = await PATCH(patch({ sustainSeconds: 30 }), ctx);
    expect(res.status).toBe(200);
    expect(updateAlertRuleThresholds).toHaveBeenCalledWith(expect.objectContaining({ ruleId: "r1", sustainSeconds: 30 }));
    expect((await res.json()).rule.sustainSeconds).toBe(30);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "alert.rule.update", target: "r1", detail: expect.objectContaining({ sustainSeconds: 30 }) }),
    );
  });

  it("null clears the override (org default)", async () => {
    updateAlertRuleThresholds.mockResolvedValue({ ...row, sustain_seconds: null });
    const { PATCH } = await import("./route");
    const res = await PATCH(patch({ sustainSeconds: null }), ctx);
    expect(res.status).toBe(200);
    expect(updateAlertRuleThresholds).toHaveBeenCalledWith(expect.objectContaining({ sustainSeconds: null }));
    expect((await res.json()).rule.sustainSeconds).toBeNull();
  });

  it.each([-1, 3601, 1.5, "30"])("rejects %s", async (bad) => {
    const { PATCH } = await import("./route");
    const res = await PATCH(patch({ sustainSeconds: bad }), ctx);
    expect(res.status).toBe(400);
    expect(updateAlertRuleThresholds).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("accepts the 0 and 3600 bounds", async () => {
    const { PATCH } = await import("./route");
    expect((await PATCH(patch({ sustainSeconds: 0 }), ctx)).status).toBe(200);
    expect((await PATCH(patch({ sustainSeconds: 3600 }), ctx)).status).toBe(200);
  });
});
