import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertPublicUrl, BlockedHostError, isBlockedIp, safeFetch } from "./safe-fetch";

describe("isBlockedIp", () => {
  const blocked = [
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "100.127.255.255", "127.0.0.1", "169.254.169.254",
    "172.16.0.1", "172.31.255.255", "192.168.1.1", "::", "::1", "fc00::1", "fd12:3456::1",
    "fe80::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:7f00:1", "garbage",
  ];
  const open = ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8"];
  it.each(blocked)("blocks %s", (ip) => expect(isBlockedIp(ip)).toBe(true));
  it.each(open)("allows %s", (ip) => expect(isBlockedIp(ip)).toBe(false));
});

describe("assertPublicUrl", () => {
  const pub = async () => ["8.8.8.8"];
  it("rejects non-http schemes", async () => {
    await expect(assertPublicUrl("file:///etc/passwd", { resolve: pub })).rejects.toBeInstanceOf(BlockedHostError);
    await expect(assertPublicUrl("gopher://x/", { resolve: pub })).rejects.toBeInstanceOf(BlockedHostError);
  });
  it("blocks literal private IPs and metadata", async () => {
    await expect(assertPublicUrl("http://169.254.169.254/latest", { allow: "" })).rejects.toThrow(/blocked_host/);
    await expect(assertPublicUrl("http://[::1]:8080/", { allow: "" })).rejects.toThrow(/blocked_host/);
  });
  it("blocks hostnames resolving private (any record)", async () => {
    await expect(
      assertPublicUrl("http://evil.example/", { resolve: async () => ["8.8.8.8", "10.0.0.1"], allow: "" }),
    ).rejects.toThrow(/blocked_host/);
  });
  it("allows public", async () => {
    const r = await assertPublicUrl("https://example.com/x", { resolve: pub, allow: "" });
    expect(r.addresses).toEqual(["8.8.8.8"]);
  });
  it("allowlist by host and by CIDR", async () => {
    const priv = async () => ["10.0.0.5"];
    await expect(assertPublicUrl("http://unifi.lan/", { resolve: priv, allow: "unifi.lan" })).resolves.toBeTruthy();
    await expect(assertPublicUrl("http://x.lan/", { resolve: priv, allow: "10.0.0.0/24" })).resolves.toBeTruthy();
    await expect(assertPublicUrl("http://x.lan/", { resolve: priv, allow: "10.0.1.0/24" })).rejects.toThrow(/blocked_host/);
  });
  it("reads HEIMDALL_ALLOW_PRIVATE_HOSTS", async () => {
    process.env.HEIMDALL_ALLOW_PRIVATE_HOSTS = "127.0.0.1";
    try {
      await expect(assertPublicUrl("http://127.0.0.1/")).resolves.toBeTruthy();
    } finally {
      delete process.env.HEIMDALL_ALLOW_PRIVATE_HOSTS;
    }
  });
});

describe("safeFetch (local server, allowlisted)", () => {
  let srv: http.Server;
  let base: string;
  const allow = "127.0.0.1";
  beforeAll(async () => {
    srv = http.createServer((req, res) => {
      if (req.url === "/ok") return void res.end("hello");
      if (req.url === "/big") return void res.end("x".repeat(5000));
      if (req.url === "/slow") return; // never respond
      if (req.url === "/r1") return void res.writeHead(302, { location: "/ok" }).end();
      if (req.url === "/loop") return void res.writeHead(302, { location: "/loop" }).end();
      if (req.url === "/to-meta") return void res.writeHead(302, { location: "http://169.254.169.254/" }).end();
      if (req.url === "/echo") {
        const b: Buffer[] = [];
        req.on("data", (c) => b.push(c)).on("end", () => res.end(`${req.method}:${Buffer.concat(b)}:${req.headers["x-t"]}`));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterAll(() => srv.close());

  it("fetches when allowlisted", async () => {
    const r = await safeFetch(`${base}/ok`, {}, { allow });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("hello");
  });
  it("refuses loopback without allowlist, before connecting", async () => {
    await expect(safeFetch(`${base}/ok`, {}, { allow: "" })).rejects.toBeInstanceOf(BlockedHostError);
  });
  it("sends method, headers, body", async () => {
    const r = await safeFetch(`${base}/echo`, { method: "POST", headers: { "x-t": "1" }, body: "abc" }, { allow });
    expect(await r.text()).toBe("POST:abc:1");
  });
  it("follows validated redirects", async () => {
    const r = await safeFetch(`${base}/r1`, {}, { allow });
    expect(await r.text()).toBe("hello");
  });
  it("caps redirects", async () => {
    await expect(safeFetch(`${base}/loop`, {}, { allow })).rejects.toThrow(/redirect/);
  });
  it("re-validates redirect targets", async () => {
    await expect(safeFetch(`${base}/to-meta`, {}, { allow })).rejects.toBeInstanceOf(BlockedHostError);
  });
  it("enforces size cap", async () => {
    await expect(safeFetch(`${base}/big`, {}, { allow, maxBytes: 1000 })).rejects.toThrow(/exceeds/);
  });
  it("enforces timeout", async () => {
    await expect(safeFetch(`${base}/slow`, {}, { allow, timeoutMs: 100 })).rejects.toThrow(/timeout/);
  });
  it("pins the validated IP (resolver result used for connect, not re-resolved)", async () => {
    const port = new URL(base).port;
    const r = await safeFetch(`http://rebind.test:${port}/ok`, {}, { allow: "rebind.test", resolve: async () => ["127.0.0.1"] });
    expect(await r.text()).toBe("hello");
  });
});
