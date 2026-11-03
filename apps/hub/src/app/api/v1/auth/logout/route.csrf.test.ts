import { describe, expect, it, vi } from "vitest";
const destroy = vi.fn(async () => {});
vi.mock("@/lib/auth/session", () => ({ getSession: async () => ({ destroy }) }));
import { POST } from "./route";

describe("logout CSRF", () => {
  it("rejects a cross-origin POST without touching the session", async () => {
    const res = await POST(new Request("http://hub.test/api/v1/auth/logout", {
      method: "POST",
      headers: { origin: "https://evil.example", host: "hub.test" },
    }));
    expect(res.status).toBe(403);
    expect(destroy).not.toHaveBeenCalled();
  });
});
