import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.fn();
vi.mock("@/lib/auth/session", () => ({ requireSession: async () => ({ orgId: "o" }) }));
vi.mock("@/lib/security/store", () => ({
  upsertSecurityConnection: (...a: unknown[]) => upsert(...a),
  listSecurityConnections: async () => [],
}));

describe("security connection save-time URL validation", () => {
  beforeEach(() => vi.resetAllMocks());

  it("rejects a private apiBaseUrl (self-hosted GitLab on LAN needs the allowlist)", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      new Request("http://hub.test/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "gitlab", name: "gl", token: "t", apiBaseUrl: "http://10.1.2.3/api/graphql" }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("blocked_host");
    expect(upsert).not.toHaveBeenCalled();
  });
});
