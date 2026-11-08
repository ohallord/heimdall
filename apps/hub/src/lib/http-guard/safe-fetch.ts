import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

export class BlockedHostError extends Error {
  code = "blocked_host" as const;
  constructor(message: string) {
    super(message);
    this.name = "BlockedHostError";
  }
}

export type Resolver = (host: string) => Promise<string[]>;

export type SafeFetchOpts = {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Override DNS (tests). */
  resolve?: Resolver;
  /** Override allowlist (tests); default reads HEIMDALL_ALLOW_PRIVATE_HOSTS. */
  allow?: string;
};

const defaultResolve: Resolver = async (host) =>
  (await dnsLookup(host, { all: true })).map((r) => r.address);

// ---------- IP parsing ----------
function parseV4(ip: string): number[] | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  const n = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  return n.some((x) => !(x >= 0 && x <= 255)) ? null : n;
}

function parseV6(ip: string): number[] | null {
  let s = ip.split("%")[0].toLowerCase();
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  if (s.includes(".")) {
    const v4 = parseV4(s.slice(lastColon + 1));
    if (!v4) return null;
    tail = v4;
    s = s.slice(0, lastColon + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (h: string) => (h === "" ? [] : h.split(":"));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push(v >> 8, v & 255);
  }
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

function toBytes(ip: string): number[] | null {
  const k = isIP(ip.split("%")[0]);
  return k === 4 ? parseV4(ip) : k === 6 ? parseV6(ip) : null;
}

function v4Blocked(b: number[]): boolean {
  const [a, c] = b;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && c >= 64 && c <= 127) ||
    (a === 169 && c === 254) ||
    (a === 172 && c >= 16 && c <= 31) ||
    (a === 192 && c === 168) ||
    (a === 192 && c === 0 && b[2] === 0) || // 192.0.0.0/24 IETF protocol assignments
    (a === 198 && (c === 18 || c === 19)) || // 198.18.0.0/15 benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

/** True when the address is loopback, private, link-local, CGNAT, ULA or unspecified. Unparseable → blocked. */
export function isBlockedIp(ip: string): boolean {
  const b = toBytes(ip);
  if (!b) return true;
  if (b.length === 4) return v4Blocked(b);
  const allZero = (x: number[]) => x.every((v) => v === 0);
  // IPv4-mapped ::ffff:a.b.c.d and deprecated IPv4-compatible ::a.b.c.d
  if (allZero(b.slice(0, 10)) && b[10] === 0xff && b[11] === 0xff) return v4Blocked(b.slice(12));
  if (allZero(b.slice(0, 12))) return true; // :: , ::1 and IPv4-compatible
  // NAT64 64:ff9b::/96 and 64:ff9b:1::/48 embed an IPv4 target; check the embedded address.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return allZero(b.slice(4, 12)) ? v4Blocked(b.slice(12)) : true;
  }
  if (b[0] === 0x20 && b[1] === 0x02) return v4Blocked(b.slice(2, 6)); // 6to4 2002::/16
  if (b[0] === 0xff) return true; // multicast ff00::/8
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // deprecated site-local fec0::/10
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10
  return false;
}

// ---------- allowlist ----------
function cidrMatch(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const a = toBytes(ip);
  const n = toBytes(base);
  if (!a || !n || a.length !== n.length) return false;
  let bits = bitsRaw === undefined ? a.length * 8 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > a.length * 8) return false;
  for (let i = 0; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((a[i] & mask) !== (n[i] & mask)) return false;
  }
  return true;
}

function allowed(host: string, ip: string, allowRaw: string): boolean {
  for (const e of allowRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (e === host.toLowerCase()) return true;
    if (isIP(e.split("/")[0]) && cidrMatch(ip, e)) return true;
  }
  return false;
}

// ---------- validation ----------
const stripBrackets = (h: string) => (h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h);

/** Validates scheme + resolved addresses; returns the addresses to connect to. Throws BlockedHostError. */
export async function assertPublicUrl(
  raw: string | URL,
  o: Pick<SafeFetchOpts, "resolve" | "allow"> = {},
): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedHostError("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedHostError(`blocked_host: scheme ${url.protocol} not allowed`);
  }
  const host = stripBrackets(url.hostname);
  const allowRaw = o.allow ?? process.env.HEIMDALL_ALLOW_PRIVATE_HOSTS ?? "";
  const addrs = isIP(host) ? [host] : await (o.resolve ?? defaultResolve)(host);
  if (addrs.length === 0) throw new BlockedHostError(`blocked_host: ${host} did not resolve`);
  for (const ip of addrs) {
    if (isBlockedIp(ip) && !allowed(host, ip, allowRaw)) {
      throw new BlockedHostError(
        `blocked_host: ${host} resolves to a private address; add it to HEIMDALL_ALLOW_PRIVATE_HOSTS to permit`,
      );
    }
  }
  return { url, addresses: addrs };
}

// ---------- fetch ----------
type Init = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal | null;
};

/** Credentials that must not follow a redirect to a different origin. */
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization", "private-token", "x-api-key"]);

function stripCredentials(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return headers;
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !CREDENTIAL_HEADERS.has(k.toLowerCase())));
}

function once(
  url: URL,
  ip: string,
  init: Init,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ status: number; headers: Headers; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: init.method ?? "GET",
        headers: init.headers,
        timeout: timeoutMs,
        // Pin the already-validated IP: no second DNS lookup, so no rebinding window.
        lookup: ((_h: string, _o: unknown, cb: (...a: unknown[]) => void) => {
          const wantAll = typeof _o === "object" && _o !== null && (_o as { all?: boolean }).all;
          const fam = isIP(ip);
          if (wantAll) cb(null, [{ address: ip, family: fam }]);
          else cb(null, ip, fam);
        }) as never,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > maxBytes) {
            const err = new Error(`response exceeds ${maxBytes} bytes`);
            reject(err);
            res.destroy();
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          if (total > maxBytes) return;
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) v.forEach((x) => h.append(k, x));
            else if (v !== undefined) h.set(k, v);
          }
          resolve({ status: res.statusCode ?? 0, headers: h, body: Buffer.concat(chunks) });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on("error", reject);
    if (init.signal) {
      if (init.signal.aborted) req.destroy(new Error("aborted"));
      else init.signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
    }
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/** SSRF-safe fetch for admin-configured URLs. Returns a standard Response (body fully buffered, size-capped). */
export async function safeFetch(
  raw: string | URL,
  init: Init = {},
  opts: SafeFetchOpts = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 3;
  let target: string | URL = raw;
  let cur = init;
  for (let hop = 0; ; hop++) {
    const { url, addresses } = await assertPublicUrl(target, opts);
    const r = await once(url, addresses[0], cur, timeoutMs, maxBytes);
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) {
      if (hop >= maxRedirects) throw new Error("too many redirects");
      const next = new URL(loc, url);
      if (next.origin !== url.origin) cur = { ...cur, headers: stripCredentials(cur.headers) };
      target = next;
      if (r.status === 303 || ((r.status === 301 || r.status === 302) && cur.method === "POST")) {
        cur = { ...cur, method: "GET", body: undefined };
      }
      continue;
    }
    const nullBody = r.status === 204 || r.status === 304;
    return new Response(nullBody ? null : new Uint8Array(r.body), { status: r.status, headers: r.headers });
  }
}

/** `fetch`-shaped SSRF-guarded fetch: the default for every admin-configured outbound URL. */
export const guardedFetch: typeof fetch = (input, init) =>
  safeFetch(input as string | URL, normalizeInit(init));

/** Map fetch's RequestInit onto what node:http can write (URLSearchParams, Headers, buffers). */
export function normalizeInit(init: RequestInit | undefined): Init {
  if (!init) return {};
  let headers: Record<string, string> | undefined;
  if (init.headers instanceof Headers) headers = Object.fromEntries(init.headers.entries());
  else if (Array.isArray(init.headers)) headers = Object.fromEntries(init.headers);
  else headers = init.headers as Record<string, string> | undefined;
  const b = init.body;
  let body: string | Uint8Array | undefined;
  if (b == null) body = undefined;
  else if (typeof b === "string") body = b;
  else if (b instanceof URLSearchParams) body = b.toString();
  else if (b instanceof Uint8Array) body = b;
  else if (b instanceof ArrayBuffer) body = new Uint8Array(b);
  else throw new TypeError("guardedFetch: unsupported body type");
  return { method: init.method, headers, body, signal: init.signal };
}
