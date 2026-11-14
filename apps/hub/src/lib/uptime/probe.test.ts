import { describe, expect, it, vi } from "vitest";
import { parseHostPort, runProbe, type ProbeCheck } from "./probe";

const base: ProbeCheck = { kind: "http", target: "https://example.com/health", timeout_ms: 1000, expected_status: null, tls_warn_days: 14 };
const publicResolve = async () => ["93.184.216.34"];
const NOW = new Date("2026-11-14T12:00:00Z").getTime();

describe("parseHostPort", () => {
  it("parses host:port, ipv6 and defaults", () => {
    expect(parseHostPort("db.example.com:5432")).toEqual({ host: "db.example.com", port: 5432 });
    expect(parseHostPort("[::1]:22")).toEqual({ host: "::1", port: 22 });
    expect(parseHostPort("example.com", 443)).toEqual({ host: "example.com", port: 443 });
    expect(parseHostPort("example.com")).toBeNull();
    expect(parseHostPort("example.com:99999")).toBeNull();
    expect(parseHostPort("http://example.com:80")).toBeNull();
  });
});

describe("http probe", () => {
  it("is up on 2xx and reports latency", async () => {
    let t = 1000;
    const fetchImpl = vi.fn(async () => {
      t += 42;
      return new Response("ok", { status: 200 });
    });
    const r = await runProbe(base, { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => t });
    expect(r).toEqual({ ok: true, latencyMs: 42 });
  });

  it("is down on 500 with the status in the error", async () => {
    const r = await runProbe(base, { fetchImpl: (async () => new Response("", { status: 503 })) as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/503/);
  });

  it("honours expected_status exactly", async () => {
    const f = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    expect((await runProbe({ ...base, expected_status: 401 }, { fetchImpl: f })).ok).toBe(true);
    const down = await runProbe({ ...base, expected_status: 200 }, { fetchImpl: f });
    expect(down.ok).toBe(false);
    expect(down.error).toMatch(/expected status 200, got 401/);
  });

  it("is down on a network error", async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
    }) as unknown as typeof fetch;
    const r = await runProbe(base, { fetchImpl });
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/ECONNREFUSED/);
  });

  it("times out", async () => {
    const fetchImpl = ((_: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })) as unknown as typeof fetch;
    const r = await runProbe({ ...base, timeout_ms: 20 }, { fetchImpl });
    expect(r).toMatchObject({ ok: false, error: "timeout" });
  });
});

describe("tcp probe", () => {
  const tcp: ProbeCheck = { ...base, kind: "tcp", target: "db.example.com:5432" };

  it("is up when the dial succeeds, dialing the validated IP", async () => {
    const dial = vi.fn(async () => undefined);
    const r = await runProbe(tcp, { dial, resolve: publicResolve });
    expect(r.ok).toBe(true);
    expect(dial).toHaveBeenCalledWith({ host: "93.184.216.34", port: 5432, timeoutMs: 1000 });
  });

  it("is down when the dial fails", async () => {
    const dial = vi.fn(async () => {
      throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    });
    const r = await runProbe(tcp, { dial, resolve: publicResolve });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ECONNREFUSED/);
  });

  it("rejects a malformed target", async () => {
    expect((await runProbe({ ...tcp, target: "nope" })).error).toMatch(/host:port/);
  });
});

describe("tls probe", () => {
  const t: ProbeCheck = { ...base, kind: "tls", target: "example.com", tls_warn_days: 14 };
  const peer = (days: number) => async () => ({ validTo: new Date(NOW + days * 86_400_000 + 3_600_000) });

  it("is up when the certificate has plenty of time left (default port 443)", async () => {
    const tlsPeer = vi.fn(peer(60));
    const r = await runProbe(t, { tlsPeer, resolve: publicResolve, now: () => NOW });
    expect(r.ok).toBe(true);
    expect(tlsPeer).toHaveBeenCalledWith({ host: "93.184.216.34", port: 443, servername: "example.com", timeoutMs: 1000 });
  });

  it("is down inside the warn window", async () => {
    const r = await runProbe(t, { tlsPeer: peer(5), resolve: publicResolve, now: () => NOW });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/expires in 5 day/);
  });

  it("is down when expired", async () => {
    const r = await runProbe(t, { tlsPeer: peer(-3), resolve: publicResolve, now: () => NOW });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/expired/);
  });

  it("is down when the handshake fails verification", async () => {
    const tlsPeer = async () => {
      throw Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    };
    const r = await runProbe(t, { tlsPeer, resolve: publicResolve });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/self-signed/);
  });
});

describe("SSRF guard", () => {
  it.each([
    ["http", "http://127.0.0.1:9/", undefined],
    ["http", "http://169.254.169.254/latest/meta-data", undefined],
    ["tcp", "10.0.0.5:22", undefined],
    ["tls", "192.168.1.1:443", undefined],
  ])("%s check of a private target %s is refused without connecting", async (kind, target) => {
    const dial = vi.fn();
    const tlsPeer = vi.fn();
    const r = await runProbe(
      { ...base, kind: kind as ProbeCheck["kind"], target },
      { dial, tlsPeer, allow: "" },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/blocked_host/);
    expect(dial).not.toHaveBeenCalled();
    expect(tlsPeer).not.toHaveBeenCalled();
  });

  it("allows a LAN target once allowlisted", async () => {
    const dial = vi.fn(async () => undefined);
    const r = await runProbe({ ...base, kind: "tcp", target: "10.0.0.5:22" }, { dial, allow: "10.0.0.5" });
    expect(r.ok).toBe(true);
    expect(dial).toHaveBeenCalled();
  });
});
