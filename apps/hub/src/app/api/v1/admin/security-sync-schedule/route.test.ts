import { beforeEach, describe, expect, it, vi } from "vitest";

const requireSession = vi.fn();
const getSecuritySyncSchedule = vi.fn();
const saveSecuritySyncSchedule = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  requireSession: (...args: unknown[]) => requireSession(...args),
}));
vi.mock("@/lib/security/schedule", () => ({
  getSecuritySyncSchedule: (...args: unknown[]) => getSecuritySyncSchedule(...args),
  saveSecuritySyncSchedule: (...args: unknown[]) => saveSecuritySyncSchedule(...args),
}));

const URL_ = "http://127.0.0.1:43123/api/v1/admin/security-sync-schedule";
const admin = { orgId: "org_1", userId: "usr_1", role: "admin", isLoggedIn: true, mfaVerified: true };
const view = { cron: "0 8 * * *", enabled: true, timeZone: "UTC" };

function put(body: unknown, headers: Record<string, string> = {}) {
  return new Request(URL_, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:43123", ...headers },
    body: JSON.stringify(body),
  });
}

describe("/api/v1/admin/security-sync-schedule", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    process.env.HEIMDALL_PUBLIC_URL = "http://127.0.0.1:43123";
  });

  it("saves with settings:write", async () => {
    requireSession.mockResolvedValue(admin);
    saveSecuritySyncSchedule.mockResolvedValue(view);
    const { PUT } = await import("./route");
    const res = await PUT(put({ cron: "0 8 * * *", enabled: true }));
    expect(res.status).toBe(200);
    expect(requireSession).toHaveBeenCalledWith({ permission: "settings:write" });
    expect(saveSecuritySyncSchedule).toHaveBeenCalledWith("org_1", {
      cron: "0 8 * * *",
      enabled: true,
      updatedBy: "usr_1",
    });
    expect(await res.json()).toMatchObject(view);
  });

  it("refuses a non-admin (operator) without saving", async () => {
    requireSession.mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
    const { PUT } = await import("./route");
    const res = await PUT(put({ cron: "0 8 * * *", enabled: true }));
    expect(res.status).toBe(403);
    expect(saveSecuritySyncSchedule).not.toHaveBeenCalled();
  });

  it("refuses an expired session", async () => {
    requireSession.mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }));
    const { PUT } = await import("./route");
    expect((await PUT(put({ cron: "0 8 * * *", enabled: true }))).status).toBe(401);
  });

  it("rejects a cross-origin request before the handler runs", async () => {
    requireSession.mockResolvedValue(admin);
    const { PUT } = await import("./route");
    const res = await PUT(put({ cron: "0 8 * * *", enabled: true }, { origin: "https://evil.test" }));
    expect(res.status).toBe(403);
    expect(requireSession).not.toHaveBeenCalled();
    expect(saveSecuritySyncSchedule).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid cron", async () => {
    requireSession.mockResolvedValue(admin);
    const { PUT } = await import("./route");
    const res = await PUT(put({ cron: "99 * * * *", enabled: true }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/minute/);
    expect(saveSecuritySyncSchedule).not.toHaveBeenCalled();
  });

  it("GET needs settings:write too", async () => {
    requireSession.mockResolvedValue(admin);
    getSecuritySyncSchedule.mockResolvedValue(view);
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(requireSession).toHaveBeenCalledWith({ permission: "settings:write" });
  });
});
