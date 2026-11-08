import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";

describe("security headers", () => {
  it("applies CSP, anti-framing, nosniff and HSTS to every route", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*");
    expect(all).toBeTruthy();
    const h = Object.fromEntries(all!.headers.map((x) => [x.key.toLowerCase(), x.value]));
    expect(h["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
    expect(h["content-security-policy"]).toMatch(/object-src 'none'/);
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["strict-transport-security"]).toMatch(/max-age=\d+/);
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
