import { safeEqual } from "@/lib/http-guard/compare";
import { accessTokenOk, wwwAuthenticate } from "@/lib/mcp/oauth";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export type McpAuthResult = { ok: true } | { ok: false; response: Response };

/** Hostname from a Host header or an allowlist entry (`localhost:43123`, `[::1]:43123`). */
export function hostnameFromHost(value: string): string {
  const raw = value.trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end > 1 ? raw.slice(1, end) : raw;
  }
  // Bare IPv6 has more than one colon and no brackets.
  if ((raw.match(/:/g) ?? []).length > 1) return raw;
  const colon = raw.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(raw.slice(colon + 1))) return raw.slice(0, colon);
  return raw;
}

function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname);
}

/** Prefer the Host header (what the hub actually received). Fall back to the URL. */
function requestHostname(request: Request): string {
  const header = request.headers.get("host") ?? request.headers.get("Host");
  if (header) return hostnameFromHost(header);
  try {
    return hostnameFromHost(new URL(request.url).host);
  } catch {
    return "";
  }
}

function presentedBearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? "";
}

function allowedHosts(env: NodeJS.ProcessEnv): Set<string> | null {
  const raw = (env.HEIMDALL_MCP_ALLOWED_HOSTS ?? "").trim();
  if (!raw) return null;
  const allowed = new Set<string>();
  for (const part of raw.split(",")) {
    const host = hostnameFromHost(part);
    if (host) allowed.add(host);
  }
  for (const local of LOCAL_HOSTS) allowed.add(local);
  return allowed;
}

/**
 * Bearer check for `/mcp`. Dashboard session cookies are ignored.
 *
 * - Token unset: only localhost / 127.0.0.1 / ::1.
 * - Token set: constant-time bearer compare. When `HEIMDALL_MCP_ALLOWED_HOSTS`
 *   is non-empty it is a Host allowlist (plus localhost). An empty allowlist
 *   accepts any Host; the bearer is the guard.
 */
export function authorizeMcpRequest(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): McpAuthResult {
  const expected = (env.HEIMDALL_MCP_TOKEN ?? "").trim();
  const hostname = requestHostname(request);

  if (!expected) {
    if (!isLocalHost(hostname)) return { ok: false, response: unauthorized(request) };
    return { ok: true };
  }

  const allow = allowedHosts(env);
  if (allow && !allow.has(hostname)) return { ok: false, response: unauthorized(request) };

  const presented = presentedBearer(request);
  if (presented && accessTokenOk(presented)) return { ok: true };
  if (!presented || !safeEqual(presented, expected)) {
    return { ok: false, response: unauthorized(request) };
  }
  return { ok: true };
}

export function unauthorized(request: Request): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "WWW-Authenticate": wwwAuthenticate(request),
      "cache-control": "no-store",
    },
  });
}
