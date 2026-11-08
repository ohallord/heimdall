import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guardedFetch, isBlockedIp, safeFetch } from "./safe-fetch";

describe("isBlockedIp: ranges found missing in review", () => {
  it.each([
    "64:ff9b::7f00:1", // NAT64 → 127.0.0.1
    "64:ff9b::a9fe:a9fe", // NAT64 → 169.254.169.254
    "2002:7f00:1::", // 6to4 → 127.0.0.1
    "2002:a9fe:a9fe::1", // 6to4 → metadata
    "fec0::1",
    "ff02::1",
    "192.0.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
  ])("blocks %s", (ip) => expect(isBlockedIp(ip)).toBe(true));
  it.each(["64:ff9b::808:808", "2002:808:808::1"])("still allows public embedded %s", (ip) =>
    expect(isBlockedIp(ip)).toBe(false),
  );
});

describe("guardedFetch / safeFetch against a local server", () => {
  let srv: http.Server;
  let other: http.Server;
  let base: string;
  let otherBase: string;
  const seen: { path: string; auth?: string; body: string; ctype?: string }[] = [];

  beforeAll(async () => {
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ path: req.url ?? "", auth: req.headers.authorization, body, ctype: req.headers["content-type"] });
        if (req.url === "/redirect-away") {
          res.writeHead(302, { location: `${otherBase}/landed` });
          return res.end();
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    };
    srv = http.createServer(handler);
    other = http.createServer(handler);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    process.env.HEIMDALL_ALLOW_PRIVATE_HOSTS = "127.0.0.1";
  });
  afterAll(() => {
    delete process.env.HEIMDALL_ALLOW_PRIVATE_HOSTS;
    srv.close();
    other.close();
  });

  it("posts a URLSearchParams body (OIDC token exchange shape)", async () => {
    const res = await guardedFetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: "abc" }),
    });
    expect(res.status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ path: "/token", body: "grant_type=authorization_code&code=abc" });
  });

  it("accepts a Headers object", async () => {
    const res = await guardedFetch(`${base}/h`, { headers: new Headers({ authorization: "Bearer t" }) });
    expect(res.status).toBe(200);
    expect(seen.at(-1)?.auth).toBe("Bearer t");
  });

  it("drops Authorization when a redirect leaves the origin", async () => {
    const res = await safeFetch(`${base}/redirect-away`, { headers: { authorization: "Bearer secret-pat" } });
    expect(res.status).toBe(200);
    const landed = seen.find((s) => s.path === "/landed");
    expect(landed).toBeTruthy();
    expect(landed?.auth).toBeUndefined();
  });

  it("honours an already-aborted signal", async () => {
    await expect(guardedFetch(`${base}/x`, { signal: AbortSignal.abort() })).rejects.toThrow(/aborted/);
  });
});
