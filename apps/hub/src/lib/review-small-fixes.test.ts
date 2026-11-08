import { afterEach, describe, expect, it } from "vitest";
import { escapeLike } from "@/lib/logs/ingest";
import { putChallenge, takeChallenge } from "@/lib/auth/challenge-store";

describe("log search treats wildcards literally", () => {
  it("escapes % _ and backslash", () => {
    expect(escapeLike("100%_done\\x")).toBe("100\\%\\_done\\\\x");
  });
});

describe("WebAuthn challenges", () => {
  it("are single-use", () => {
    putChallenge("u1", "c1");
    expect(takeChallenge("u1")).toBe("c1");
    expect(takeChallenge("u1")).toBeUndefined();
  });
  it("expire after five minutes", () => {
    const t0 = 1_000_000;
    putChallenge("u2", "c2", t0);
    expect(takeChallenge("u2", t0 + 5 * 60_000 + 1)).toBeUndefined();
  });
});

describe("OIDC redirect base in production", () => {
  const prev = { node: process.env.NODE_ENV, url: process.env.HEIMDALL_PUBLIC_URL };
  afterEach(() => {
    process.env.NODE_ENV = prev.node;
    if (prev.url === undefined) delete process.env.HEIMDALL_PUBLIC_URL;
    else process.env.HEIMDALL_PUBLIC_URL = prev.url;
  });
  it("refuses to derive redirect_uri from the Host header", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.HEIMDALL_PUBLIC_URL;
    const { GET } = await import("@/app/api/v1/auth/oidc/callback/route");
    const res = await GET(new Request("http://evil.example/api/v1/auth/oidc/callback?code=x&state=y"));
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
  });
});
