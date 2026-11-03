import { describe, expect, it } from "vitest";
import { cookieSecure } from "./cookie-secure";

describe("cookieSecure", () => {
  it("is false for HTTP public URL even when NODE_ENV=production (Compose)", () => {
    expect(
      cookieSecure({
        NODE_ENV: "production",
        HEIMDALL_PUBLIC_URL: "http://127.0.0.1:43123",
      }),
    ).toBe(false);
  });

  it("is true for HTTPS public URL", () => {
    expect(
      cookieSecure({
        NODE_ENV: "production",
        HEIMDALL_PUBLIC_URL: "https://heimdall.example.com",
      }),
    ).toBe(true);
  });

  it("respects HEIMDALL_COOKIE_SECURE override", () => {
    expect(
      cookieSecure({
        NODE_ENV: "production",
        HEIMDALL_PUBLIC_URL: "https://heimdall.example.com",
        HEIMDALL_COOKIE_SECURE: "false",
      }),
    ).toBe(false);
    expect(
      cookieSecure({
        NODE_ENV: "production",
        HEIMDALL_PUBLIC_URL: "http://127.0.0.1:43123",
        HEIMDALL_COOKIE_SECURE: "true",
      }),
    ).toBe(true);
  });

  it("falls back to NODE_ENV when public URL is unset", () => {
    expect(cookieSecure({ NODE_ENV: "production" })).toBe(true);
    expect(cookieSecure({ NODE_ENV: "development" })).toBe(false);
  });
});
