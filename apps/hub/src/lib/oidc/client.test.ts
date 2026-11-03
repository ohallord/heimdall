import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildAuthorizationUrl,
  discoverOidc,
  exchangeCode,
  fetchUserInfo,
} from "./client";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(path.join(__dirname, "fixtures", name), "utf8"),
  );
}

describe("oidc client", () => {
  it("discovers endpoints from well-known", async () => {
    const discovery = fixture("discovery.json") as {
      issuer: string;
      authorization_endpoint: string;
    };
    const fetchImpl = async (url: string | URL | Request) => {
      expect(String(url)).toContain("/.well-known/openid-configuration");
      return new Response(JSON.stringify(discovery), { status: 200 });
    };
    const doc = await discoverOidc("https://idp.test/realms/heimdall/", fetchImpl);
    expect(doc.authorization_endpoint).toContain("openid-connect/auth");
  });

  it("builds authorization URL with state and nonce", () => {
    const url = buildAuthorizationUrl({
      authorizationEndpoint:
        "https://idp.test/realms/heimdall/protocol/openid-connect/auth",
      clientId: "heimdall",
      redirectUri: "http://127.0.0.1:43123/api/v1/auth/oidc/callback",
      scope: "openid profile email",
      state: "st",
      nonce: "nn",
      codeChallenge: "cc",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("client_id")).toBe("heimdall");
    expect(parsed.searchParams.get("state")).toBe("st");
    expect(parsed.searchParams.get("nonce")).toBe("nn");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("code_challenge")).toBe("cc");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("exchanges code and fetches userinfo", async () => {
    const token = fixture("token.json");
    const userinfo = fixture("userinfo.json");
    const fetchImpl = async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const u = String(url);
      if (u.includes("/token")) {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify(token), { status: 200 });
      }
      if (u.includes("/userinfo")) {
        return new Response(JSON.stringify(userinfo), { status: 200 });
      }
      throw new Error(`unexpected ${u}`);
    };

    const tokens = await exchangeCode({
      tokenEndpoint:
        "https://idp.test/realms/heimdall/protocol/openid-connect/token",
      clientId: "heimdall",
      clientSecret: "secret",
      code: "abc",
      redirectUri: "http://127.0.0.1:43123/api/v1/auth/oidc/callback",
      codeVerifier: "ver",
      fetchImpl,
    });
    expect(tokens.access_token).toBe("access-token-test");

    const info = await fetchUserInfo({
      userinfoEndpoint:
        "https://idp.test/realms/heimdall/protocol/openid-connect/userinfo",
      accessToken: tokens.access_token,
      fetchImpl,
    });
    expect(info.email).toBe("oidc.user@example.com");
    expect(info.sub).toBe("user-1");
  });
});
