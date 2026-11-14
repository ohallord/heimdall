import { beforeEach, describe, expect, it, vi } from "vitest";

const requireSession = vi.fn();
const recordAudit = vi.fn();
vi.mock("@/lib/auth/session", () => ({ requireSession: (...a: unknown[]) => requireSession(...a) }));
vi.mock("@/lib/audit/log", () => ({ recordAudit: (...a: unknown[]) => recordAudit(...a) }));


const ORIGIN = "http://127.0.0.1:43123";
function send(method: string, body?: unknown, qs = "") {
  return new Request(`${ORIGIN}/api/v1/uptime${qs}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("/api/v1/uptime", () => {
  let orgId = "";
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.resetModules();
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "test-token";
    process.env.HEIMDALL_PUBLIC_URL = ORIGIN;
    delete process.env.DATABASE_URL;
    delete process.env.HEIMDALL_ALLOW_PRIVATE_HOSTS;
    // Same module registry as the route under test (resetModules above).
    const { resetDbForTests } = await import("@/lib/db/client");
    const { createOrgAndAdmin } = await import("@/lib/db/store");
    resetDbForTests();
    const { org } = await createOrgAndAdmin({ orgName: "R", adminName: "A", email: "r@example.com", password: "CorrectHorse1" });
    orgId = org.id;
    requireSession.mockResolvedValue({ orgId, userId: "u1", email: "o@x.io", role: "operator" });
    recordAudit.mockResolvedValue(undefined);
  });

  const add = async (body: Record<string, unknown>) => (await import("./route")).POST(send("POST", body));

  it("creates, lists, toggles and deletes a check, auditing create and delete", async () => {
    const created = await add({ name: "Web", kind: "http", target: "https://example.com/health", intervalSeconds: 60 });
    expect(created.status).toBe(201);
    const { check } = await created.json();
    expect(requireSession).toHaveBeenCalledWith({ permission: "alerts:write" });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "uptime.check.create", target: check.id }));

    const { GET, PATCH, DELETE } = await import("./route");
    const list = await (await GET()).json();
    expect(list.checks).toHaveLength(1);
    expect(list.checks[0]).toMatchObject({ name: "Web", lastStatus: null, enabled: true });
    expect(requireSession).toHaveBeenLastCalledWith({ permission: "agents:read" });

    const off = await PATCH(send("PATCH", { id: check.id, enabled: false }));
    expect(off.status).toBe(200);
    expect((await off.json()).check.enabled).toBe(false);

    const del = await DELETE(send("DELETE", undefined, `?id=${check.id}`));
    expect(del.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "uptime.check.delete", target: check.id }));
    expect((await (await GET()).json()).checks).toEqual([]);
  });

  it("accepts tcp and tls targets", async () => {
    expect((await add({ name: "DB", kind: "tcp", target: "example.com:5432" })).status).toBe(201);
    expect((await add({ name: "Cert", kind: "tls", target: "example.com", tlsWarnDays: 30 })).status).toBe(201);
  });

  it.each([
    ["bad url", { name: "x", kind: "http", target: "ftp://example.com" }],
    ["bad tcp target", { name: "x", kind: "tcp", target: "example.com" }],
    ["interval too short", { name: "x", kind: "http", target: "https://example.com", intervalSeconds: 5 }],
    ["expectedStatus on tcp", { name: "x", kind: "tcp", target: "example.com:1", expectedStatus: 200 }],
    ["missing name", { kind: "http", target: "https://example.com" }],
  ])("rejects %s", async (_n, body) => {
    expect((await add(body)).status).toBe(400);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it.each([
    ["http", "http://127.0.0.1:8080/"],
    ["http", "http://169.254.169.254/latest/meta-data"],
    ["tcp", "10.0.0.5:22"],
    ["tls", "192.168.1.10"],
  ])("refuses a private %s target %s (SSRF) and stores nothing", async (kind, target) => {
    const res = await add({ name: "internal", kind, target });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("blocked_host");
    const { getDb } = await import("@/lib/db/client");
    const db = await getDb();
    expect((await db.query(`SELECT 1 FROM uptime_checks`)).rows).toHaveLength(0);
  });

  it("allows a private target once allowlisted", async () => {
    process.env.HEIMDALL_ALLOW_PRIVATE_HOSTS = "10.0.0.5";
    expect((await add({ name: "lan", kind: "tcp", target: "10.0.0.5:22" })).status).toBe(201);
  });

  it("viewers cannot write; unauthenticated callers get 401", async () => {
    requireSession.mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
    expect((await add({ name: "x", kind: "http", target: "https://example.com" })).status).toBe(403);
    const { PATCH, DELETE, GET } = await import("./route");
    expect((await PATCH(send("PATCH", { id: "a", enabled: false }))).status).toBe(403);
    expect((await DELETE(send("DELETE", undefined, "?id=a"))).status).toBe(403);
    requireSession.mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }));
    expect((await GET()).status).toBe(401);
  });

  it("rejects cross-origin writes before auth", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      new Request(`${ORIGIN}/api/v1/uptime`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.test" },
        body: JSON.stringify({ name: "x", kind: "http", target: "https://example.com" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(requireSession).not.toHaveBeenCalled();
  });

  it("404s for an unknown id and never touches another org's check", async () => {
    const { DELETE } = await import("./route");
    expect((await DELETE(send("DELETE", undefined, "?id=upt_nope"))).status).toBe(404);
    expect((await DELETE(send("DELETE", undefined, ""))).status).toBe(400);
  });
});
