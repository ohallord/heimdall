import { beforeEach, describe, expect, it, vi } from "vitest";

const requireSession = vi.fn();
const recordAudit = vi.fn();
const saveSecuritySyncSchedule = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  requireSession: (...a: unknown[]) => requireSession(...a),
}));
vi.mock("@/lib/audit/log", () => ({
  recordAudit: (...a: unknown[]) => recordAudit(...a),
}));
vi.mock("@/lib/security/schedule", () => ({
  getSecuritySyncSchedule: vi.fn(),
  saveSecuritySyncSchedule: (...a: unknown[]) => saveSecuritySyncSchedule(...a),
}));
vi.mock("@/lib/alerts/sustain-settings", () => ({
  MAX_ALERT_SUSTAIN_SECONDS: 3600,
  getAlertSustainSeconds: async () => 120,
  setAlertSustainSeconds: async (_o: string, n: number) => n,
}));
vi.mock("@/lib/metrics/retention", () => ({
  getMetricsRetentionDays: async () => 60,
  getLogsRetentionDays: async () => 60,
  getTracesRetentionDays: async () => 7,
  setMetricsRetentionDays: async () => 60,
  setLogsRetentionDays: async (_o: string, n: number) => n,
  setTracesRetentionDays: async () => 7,
}));
vi.mock("@/lib/security/settings", () => ({
  getCriticalFindingsToAlarms: async () => true,
  setCriticalFindingsToAlarms: async () => true,
}));

const ORIGIN = "http://127.0.0.1:43123";
const session = { orgId: "org_1", userId: "usr_1", email: "a@x.io", role: "admin" };

function send(method: string, path: string, body: unknown) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

describe("audit call sites", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    process.env.HEIMDALL_PUBLIC_URL = ORIGIN;
    requireSession.mockResolvedValue(session);
    recordAudit.mockResolvedValue(undefined);
  });

  it("security sync schedule save records an entry", async () => {
    saveSecuritySyncSchedule.mockResolvedValue({ cron: "0 9 * * *", enabled: true });
    const { PUT } = await import("./admin/security-sync-schedule/route");
    const res = await PUT(send("PUT", "/api/v1/admin/security-sync-schedule", { cron: "0 9 * * *", enabled: true }));
    expect(res.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        session,
        action: "security.sync_schedule.update",
        detail: { cron: "0 9 * * *", enabled: true },
      }),
    );
  });

  it("org settings PATCH records the changed fields", async () => {
    const { PATCH } = await import("./org/settings/route");
    const res = await PATCH(send("PATCH", "/api/v1/org/settings", { logsRetentionDays: 14 }));
    expect(res.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "org.settings.update",
        target: "org_1",
        detail: { logsRetentionDays: 14 },
      }),
    );
  });

  it("does not record when the request is rejected", async () => {
    const { PATCH } = await import("./org/settings/route");
    const res = await PATCH(send("PATCH", "/api/v1/org/settings", { alertSustainSeconds: 99999 }));
    expect(res.status).toBe(400);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
