import { afterEach, describe, expect, it } from "vitest";
import { assertSameOrigin } from "./csrf";

const r = (h: Record<string, string>, url = "https://hub.example.com/api/x") =>
  new Request(url, { method: "POST", headers: h });

afterEach(() => delete process.env.HEIMDALL_PUBLIC_URL);

describe("assertSameOrigin", () => {
  it("allows matching Origin (request host)", () => {
    expect(assertSameOrigin(r({ origin: "https://hub.example.com", host: "hub.example.com" }))).toBe(true);
  });
  it("rejects mismatched Origin", () => {
    expect(assertSameOrigin(r({ origin: "https://evil.com", host: "hub.example.com" }))).toBe(false);
  });
  it("rejects Sec-Fetch-Site cross-site / same-site", () => {
    expect(assertSameOrigin(r({ "sec-fetch-site": "cross-site", host: "hub.example.com" }))).toBe(false);
  });
  it("allows Sec-Fetch-Site same-origin and none", () => {
    expect(assertSameOrigin(r({ "sec-fetch-site": "same-origin", host: "hub.example.com" }))).toBe(true);
    expect(assertSameOrigin(r({ "sec-fetch-site": "none", host: "hub.example.com" }))).toBe(true);
  });
  it("prefers HEIMDALL_PUBLIC_URL over host header", () => {
    process.env.HEIMDALL_PUBLIC_URL = "https://hub.example.com/";
    expect(assertSameOrigin(r({ origin: "https://hub.example.com", host: "internal:3000" }))).toBe(true);
    expect(assertSameOrigin(r({ origin: "http://internal:3000", host: "internal:3000" }))).toBe(false);
  });
  it("allows requests with neither Origin nor Sec-Fetch-Site (non-browser)", () => {
    expect(assertSameOrigin(r({ host: "hub.example.com" }))).toBe(true);
  });
  it("rejects Origin: null", () => {
    expect(assertSameOrigin(r({ origin: "null", host: "hub.example.com" }))).toBe(false);
  });
  it("honors x-forwarded-host/proto only never (uses host header)", () => {
    expect(
      assertSameOrigin(r({ origin: "https://evil.com", host: "hub.example.com", "x-forwarded-host": "evil.com" })),
    ).toBe(false);
  });
});
