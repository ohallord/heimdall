import { describe, expect, it, vi } from "vitest";
import { apiError } from "./api-error";

describe("apiError", () => {
  it("hides unexpected error text (driver/upstream detail) behind internal_error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = apiError(new Error('relation "users" does not exist at postgres://heimdall:pw@db'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
  });
  it("keeps our own 4xx messages", async () => {
    const res = apiError(Object.assign(new Error("forbidden"), { status: 403 }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });
});
