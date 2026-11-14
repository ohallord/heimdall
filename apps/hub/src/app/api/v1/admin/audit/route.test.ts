import { beforeEach, describe, expect, it, vi } from "vitest";

const requireSession = vi.fn();
const listAudit = vi.fn();

vi.mock("@/lib/auth/session", () => ({
  requireSession: (...a: unknown[]) => requireSession(...a),
}));
vi.mock("@/lib/audit/log", async (orig) => ({
  ...(await orig<typeof import("@/lib/audit/log")>()),
  listAudit: (...a: unknown[]) => listAudit(...a),
}));

const req = (qs = "") => new Request(`http://127.0.0.1:43123/api/v1/admin/audit${qs}`);

describe("GET /api/v1/admin/audit", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  it("requires settings:write and returns the page", async () => {
    requireSession.mockResolvedValue({ orgId: "org_1" });
    listAudit.mockResolvedValue({ rows: [{ id: "a1" }], nextCursor: "c" });
    const { GET } = await import("./route");
    const res = await GET(req("?action=org.settings.update&limit=10&cursor=xyz"));
    expect(res.status).toBe(200);
    expect(requireSession).toHaveBeenCalledWith({ permission: "settings:write" });
    expect(listAudit).toHaveBeenCalledWith("org_1", { action: "org.settings.update", limit: 10, cursor: "xyz" });
    expect(await res.json()).toEqual({ entries: [{ id: "a1" }], nextCursor: "c" });
  });

  it("clamps the limit", async () => {
    requireSession.mockResolvedValue({ orgId: "org_1" });
    listAudit.mockResolvedValue({ rows: [], nextCursor: null });
    const { GET } = await import("./route");
    await GET(req("?limit=99999"));
    expect(listAudit.mock.calls[0][1].limit).toBe(200);
  });

  it("refuses an operator without reading", async () => {
    requireSession.mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
    const { GET } = await import("./route");
    expect((await GET(req())).status).toBe(403);
    expect(listAudit).not.toHaveBeenCalled();
  });

  it("refuses an anonymous caller", async () => {
    requireSession.mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }));
    const { GET } = await import("./route");
    expect((await GET(req())).status).toBe(401);
  });
});
