import { createHash, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createOrgAndAdmin } from "@/lib/db/store";
import { resetDbForTests } from "@/lib/db/client";
import { POST as mcpPost } from "@/app/mcp/route";
import { GET as resourceGet } from "@/app/.well-known/oauth-protected-resource/mcp/route";
import { POST as registerPost } from "@/app/oauth/register/route";
import { GET as authorizeGet, POST as authorizePost } from "@/app/oauth/authorize/route";
import { POST as tokenPost } from "@/app/oauth/token/route";
import { resetOAuthState } from "./oauth";

function verifierPair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

describe("heimdall mcp oauth", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "test-token";
    process.env.HEIMDALL_SESSION_SECRET = "test-session-secret";
    process.env.HEIMDALL_MCP_TOKEN = "static-token";
    delete process.env.DATABASE_URL;
    delete process.env.HEIMDALL_MCP_ALLOWED_HOSTS;
    resetDbForTests();
    resetOAuthState();
  });

  it("advertises the public resource and refuses an unknown redirect host", async () => {
    const metadata = await resourceGet(
      new Request("https://heimdall.drohalloran.dev/mcp", {
        headers: { host: "heimdall.drohalloran.dev", "x-forwarded-proto": "https" },
      }),
    );
    expect(await metadata.json()).toMatchObject({
      resource: "https://heimdall.drohalloran.dev/mcp",
      authorization_servers: ["https://heimdall.drohalloran.dev"],
    });

    const refused = await registerPost(
      new Request("https://heimdall.drohalloran.dev/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://evil.example/callback"] }),
      }),
    );
    expect(refused.status).toBe(400);
  });

  it("signs Grok in with the hub password and accepts the access token on /mcp", async () => {
    await createOrgAndAdmin({
      orgName: "home",
      adminName: "dan",
      email: "dan@example.com",
      password: "GoodPass12",
    });
    const { verifier, challenge } = verifierPair();
    const registered = await registerPost(
      new Request("https://heimdall.drohalloran.dev/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Grok",
          redirect_uris: ["https://grok.com/callback", "cursor://anysphere.cursor-mcp/oauth"],
        }),
      }),
    );
    expect(registered.status).toBe(201);
    const client = (await registered.json()) as { client_id: string; redirect_uris: string[] };
    expect(client.redirect_uris).toEqual(["https://grok.com/callback"]);

    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "https://grok.com/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "st",
    });
    const login = await authorizePost(
      new Request(`https://heimdall.drohalloran.dev/oauth/authorize?${query}`, {
        method: "POST",
        body: new URLSearchParams({
          ...Object.fromEntries(query),
          intent: "login",
          email: "dan@example.com",
          password: "GoodPass12",
        }),
      }),
    );
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie") ?? "";
    expect(cookie.startsWith("hm_oauth=")).toBe(true);

    const allow = await authorizePost(
      new Request("https://heimdall.drohalloran.dev/oauth/authorize", {
        method: "POST",
        headers: { cookie: cookie.split(";")[0] },
        body: new URLSearchParams({ ...Object.fromEntries(query), intent: "allow" }),
      }),
    );
    expect(allow.status).toBe(303);
    const redirected = new URL(allow.headers.get("location") ?? "");
    expect(redirected.origin).toBe("https://grok.com");
    expect(redirected.searchParams.get("state")).toBe("st");
    const code = redirected.searchParams.get("code") ?? "";

    const traded = await tokenPost(
      new Request("https://heimdall.drohalloran.dev/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          client_id: client.client_id,
          redirect_uri: "https://grok.com/callback",
        }),
      }),
    );
    expect(traded.status).toBe(200);
    const tokens = (await traded.json()) as { access_token: string };
    const replay = await tokenPost(
      new Request("https://heimdall.drohalloran.dev/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          client_id: client.client_id,
          redirect_uri: "https://grok.com/callback",
        }),
      }),
    );
    expect(replay.status).toBe(400);

    const mcp = await mcpPost(
      new Request("https://heimdall.drohalloran.dev/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          host: "heimdall.drohalloran.dev",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "grok", version: "0" },
          },
        }),
      }),
    );
    expect(mcp.status).toBe(200);

    const anon = await authorizeGet(
      new Request(`https://heimdall.drohalloran.dev/oauth/authorize?${query}`),
    );
    expect(anon.status).toBe(200);
    expect(await anon.text()).toContain("Password");
  });
});
