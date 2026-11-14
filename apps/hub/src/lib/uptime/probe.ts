import net from "node:net";
import tls from "node:tls";
import { assertPublicUrl, BlockedHostError, guardedFetch, type Resolver } from "@/lib/http-guard/safe-fetch";

export type UptimeKind = "http" | "tcp" | "tls";

export type ProbeCheck = {
  kind: UptimeKind;
  target: string;
  timeout_ms: number;
  expected_status: number | null;
  tls_warn_days: number;
};

export type ProbeResult = { ok: boolean; latencyMs: number; error?: string };

export type ProbeDeps = {
  /** Replaces guardedFetch (tests). */
  fetchImpl?: typeof fetch;
  /** Replaces the TCP dial (tests). Receives the validated IP. */
  dial?: (a: { host: string; port: number; timeoutMs: number }) => Promise<void>;
  /** Replaces the TLS handshake (tests). Receives the validated IP and the SNI name. */
  tlsPeer?: (a: { host: string; port: number; servername: string; timeoutMs: number }) => Promise<{ validTo: Date }>;
  resolve?: Resolver;
  allow?: string;
  now?: () => number;
};

/** "host:port" or "[v6]:port" (port optional when `defaultPort` is given). */
export function parseHostPort(
  target: string,
  defaultPort?: number,
): { host: string; port: number } | null {
  const t = target.trim();
  const m = t.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/) ?? t.match(/^([^:\s/]+)(?::(\d{1,5}))?$/);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (!port || port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

/** http:// stand-in so TCP/TLS targets go through the same SSRF rules (and allowlist) as HTTP. */
function probeUrl(host: string, port: number): string {
  const h = host.includes(":") ? `[${host}]` : host;
  return `http://${h}:${port}/`;
}

function dialTcp(a: { host: string; port: number; timeoutMs: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: a.host, port: a.port });
    const done = (err?: Error) => {
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(a.timeoutMs, () => done(new Error(`timeout after ${a.timeoutMs}ms`)));
    socket.once("connect", () => done());
    socket.once("error", (e) => done(e));
  });
}

function tlsHandshake(a: {
  host: string;
  port: number;
  servername: string;
  timeoutMs: number;
}): Promise<{ validTo: Date }> {
  return new Promise((resolve, reject) => {
    // Verification stays on: an expired, self-signed or mismatched certificate is a failed check.
    const socket = tls.connect({ host: a.host, port: a.port, servername: a.servername, rejectUnauthorized: true });
    const done = (err?: Error, validTo?: Date) => {
      socket.destroy();
      if (err) reject(err);
      else resolve({ validTo: validTo! });
    };
    socket.setTimeout(a.timeoutMs, () => done(new Error(`timeout after ${a.timeoutMs}ms`)));
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
      if (!validTo || Number.isNaN(validTo.getTime())) done(new Error("certificate has no expiry date"));
      else done(undefined, validTo);
    });
    socket.once("error", (e) => done(e));
  });
}

function describeError(err: unknown): string {
  if (err instanceof BlockedHostError) return err.message;
  const e = err as { code?: string; message?: string; name?: string };
  if (e?.name === "AbortError") return "timeout";
  const msg = e?.message || String(err);
  return e?.code && !msg.includes(e.code) ? `${e.code}: ${msg}` : msg;
}

const DAY_MS = 86_400_000;

/** Run one check. Never throws: every failure (including a blocked target) is a down result. */
export async function runProbe(check: ProbeCheck, deps: ProbeDeps = {}): Promise<ProbeResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const fail = (error: string): ProbeResult => ({ ok: false, latencyMs: Math.max(0, now() - started), error });
  const ok = (): ProbeResult => ({ ok: true, latencyMs: Math.max(0, now() - started) });
  const guardOpts = { resolve: deps.resolve, allow: deps.allow };

  try {
    if (check.kind === "http") {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), check.timeout_ms);
      try {
        const fetchFn = deps.fetchImpl ?? guardedFetch;
        const res = await fetchFn(check.target, {
          method: "GET",
          headers: { "user-agent": "heimdall-uptime" },
          signal: controller.signal,
        });
        const status = res.status;
        void res.body?.cancel().catch(() => undefined);
        const good = check.expected_status != null ? status === check.expected_status : status >= 200 && status < 400;
        if (good) return ok();
        return fail(
          check.expected_status != null
            ? `expected status ${check.expected_status}, got ${status}`
            : `unexpected status ${status}`,
        );
      } finally {
        clearTimeout(timer);
      }
    }

    if (check.kind === "tcp") {
      const hp = parseHostPort(check.target);
      if (!hp) return fail("target must be host:port");
      const { addresses } = await assertPublicUrl(probeUrl(hp.host, hp.port), guardOpts);
      await (deps.dial ?? dialTcp)({ host: addresses[0], port: hp.port, timeoutMs: check.timeout_ms });
      return ok();
    }

    const hp = parseHostPort(check.target, 443);
    if (!hp) return fail("target must be host or host:port");
    const { addresses } = await assertPublicUrl(probeUrl(hp.host, hp.port), guardOpts);
    const peer = await (deps.tlsPeer ?? tlsHandshake)({
      host: addresses[0],
      port: hp.port,
      servername: hp.host,
      timeoutMs: check.timeout_ms,
    });
    const daysLeft = Math.floor((peer.validTo.getTime() - now()) / DAY_MS);
    if (daysLeft < 0) return fail(`certificate expired ${-daysLeft} day(s) ago`);
    if (daysLeft < check.tls_warn_days) {
      return fail(`certificate expires in ${daysLeft} day(s) (warn at ${check.tls_warn_days})`);
    }
    return ok();
  } catch (err) {
    return fail(describeError(err));
  }
}
