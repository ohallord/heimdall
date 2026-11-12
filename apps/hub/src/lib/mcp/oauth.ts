import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import {
  claimTotpStep,
  consumeRecoveryCode,
  findUserByLogin,
} from "@/lib/db/store";
import { totpStep } from "@/lib/mfa/totp";
import { clientIp, limit, presetFor } from "@/lib/http-guard/rate-limit";

/** Access-token prefix. Static HEIMDALL_MCP_TOKEN values are not this shape. */
export const ACCESS_PREFIX = "hmo.";

const CODE_SECONDS = 300;
const ACCESS_SECONDS = 3600;
const REFRESH_SECONDS = 30 * 24 * 3600;
const SESSION_SECONDS = 12 * 3600;
const MAX_REDIRECTS = 5;
const COOKIE = "hm_oauth";

const REDIRECT_HOSTS = [
  "grok.com",
  "x.ai",
  "claude.ai",
  "chatgpt.com",
  "cursor.com",
  "localhost",
  "127.0.0.1",
];

// ponytail: spent codes and refresh tokens live in this process. One hub replica.
// A restart forgets them, so a refresh token can be reused once after a restart
// until it expires. Move this set to a table if the hub ever runs more than one replica.
const spent = new Set<string>();

let dummyHash: Promise<string> | undefined;

export function resetOAuthState(): void {
  spent.clear();
}

export function issuer(request: Request): string {
  const host = request.headers.get("host") || new URL(request.url).host;
  const forwarded = (request.headers.get("x-forwarded-proto") ?? "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const scheme =
    forwarded === "https" || forwarded === "http"
      ? forwarded
      : new URL(request.url).protocol.replace(":", "");
  return `${scheme}://${host}`;
}

export function wwwAuthenticate(request: Request): string {
  return `Bearer realm="heimdall", resource_metadata="${issuer(request)}/.well-known/oauth-protected-resource"`;
}

function secret(): Buffer | null {
  const raw = (process.env.HEIMDALL_SESSION_SECRET ?? "").trim();
  if (!raw) return null;
  return createHash("sha256").update(raw).digest();
}

function sign(payload: Record<string, unknown>): string | null {
  const key = secret();
  if (!key) return null;
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", key).update(body).digest("base64url");
  return `${ACCESS_PREFIX}${body}.${mac}`;
}

function open(token: string): Record<string, unknown> | null {
  const key = secret();
  if (!key || !token.startsWith(ACCESS_PREFIX)) return null;
  const rest = token.slice(ACCESS_PREFIX.length);
  const dot = rest.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = rest.slice(0, dot);
  const mac = rest.slice(dot + 1);
  const expect = createHmac("sha256", key).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function fresh(payload: Record<string, unknown>, kind: string): boolean {
  return payload.k === kind && typeof payload.exp === "number" && payload.exp > Date.now() / 1000;
}

export function accessTokenOk(token: string): boolean {
  const payload = open(token);
  return Boolean(payload && fresh(payload, "access"));
}

export function redirectAllowed(uri: string): boolean {
  if (!uri || /[\\@#\s]/.test(uri)) return false;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol === "https:") {
    return REDIRECT_HOSTS.some((name) => host === name || host.endsWith(`.${name}`));
  }
  return parsed.protocol === "http:" && (host === "localhost" || host === "127.0.0.1");
}

function pkce(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function remember(id: string): boolean {
  if (spent.has(id)) return false;
  spent.add(id);
  if (spent.size > 10_000) spent.clear();
  return true;
}

function attr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

function page(title: string, body: string, status = 200, headers?: Headers): Response {
  const response = new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>
:root{--bg:#f4f6f8;--fg:#161616;--surface:#fff;--border:#c6c6c6;--muted:#525252;--signal:#007d79;--danger:#da1e28}
body{margin:0;min-height:100vh;color:var(--fg);background:linear-gradient(180deg,#eef2f5 0%,var(--bg) 40%,#ebeff3 100%);font-family:"IBM Plex Sans",system-ui,sans-serif}
main{max-width:28rem;margin:0 auto;padding:2.5rem 1.5rem}
.kicker{margin:0;font-family:ui-monospace,"IBM Plex Mono",monospace;font-size:.75rem;letter-spacing:.2em;text-transform:uppercase;color:var(--signal)}
h1{margin:.25rem 0 1.5rem;font-size:1.875rem;font-weight:600;letter-spacing:-.02em}
form{display:flex;flex-direction:column;gap:1rem;border:1px solid var(--border);background:var(--surface);padding:1.25rem}
label{display:block;font-size:.875rem}
label span{display:block;margin-bottom:.25rem;font-family:ui-monospace,monospace;font-size:.75rem;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
input{width:100%;box-sizing:border-box;border:1px solid var(--border);padding:.5rem .75rem;font:inherit;background:#fff}
button{align-self:flex-start;background:var(--signal);color:#fff;border:0;padding:.5rem 1rem;font:inherit;font-size:.875rem;cursor:pointer}
.error{border:1px solid color-mix(in srgb,var(--danger) 40%,transparent);background:#fff;color:var(--danger);padding:.5rem .75rem;font-size:.875rem}
</style></head><body><main><p class="kicker">Heimdall</p><h1>${title}</h1>${body}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
  headers?.forEach((value, key) => response.headers.append(key, value));
  return response;
}

function sessionUser(request: Request): string | null {
  const raw = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!raw) return null;
  const payload = open(decodeURIComponent(raw));
  if (!payload || !fresh(payload, "session") || typeof payload.uid !== "string") return null;
  return payload.uid;
}

function sessionCookie(userId: string, request: Request): string {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const token = sign({ k: "session", uid: userId, exp }) ?? "";
  const secure = issuer(request).startsWith("https://") ? "; Secure" : "";
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/oauth; Max-Age=${SESSION_SECONDS}${secure}`;
}

export function protectedResource(request: Request): Response {
  const base = issuer(request);
  return Response.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: ["mcp"],
  });
}

export function authorizationServer(request: Request): Response {
  const base = issuer(request);
  return Response.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}

export async function oauthRegister(request: Request): Promise<Response> {
  if (!secret()) return Response.json({ error: "server_error" }, { status: 500 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_client_metadata" }, { status: 400 });
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const listed = record.redirect_uris;
  if (
    !Array.isArray(listed) ||
    listed.length < 1 ||
    listed.length > MAX_REDIRECTS ||
    !listed.every(
      (uri): uri is string => typeof uri === "string" && uri.length > 0 && !uri.includes("\n"),
    )
  ) {
    return Response.json({ error: "invalid_client_metadata" }, { status: 400 });
  }
  const uris = listed.filter((uri) => {
    try {
      const scheme = new URL(uri).protocol;
      return scheme === "https:" || scheme === "http:";
    } catch {
      return false;
    }
  });
  if (uris.length === 0 || !uris.every((uri) => redirectAllowed(uri))) {
    return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
  }
  const name = String(record.client_name || "mcp").slice(0, 80);
  const clientId = sign({ k: "client", u: uris, n: name });
  if (!clientId) return Response.json({ error: "server_error" }, { status: 500 });
  return Response.json(
    {
      client_id: clientId,
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    { status: 201 },
  );
}

function clientAllows(clientId: string, redirectUri: string): boolean {
  const payload = open(clientId);
  if (!payload || payload.k !== "client" || !Array.isArray(payload.u)) return false;
  return redirectAllowed(redirectUri) && payload.u.includes(redirectUri);
}

function hidden(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${attr(value)}">`)
    .join("");
}

function loginForm(fields: Record<string, string>, error = ""): string {
  return `${error ? `<p class="error">${attr(error)}</p>` : ""}<form method="post" action="/oauth/authorize">${hidden({ ...fields, intent: "login" })}<label><span>Email or username</span><input name="login" type="text" autocomplete="username" required></label><label><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label><label><span>Authenticator code</span><input name="code" type="text" inputmode="numeric" autocomplete="one-time-code"></label><button>Sign in</button></form>`;
}

function allowForm(fields: Record<string, string>): string {
  return `<p>Allow this client to read Heimdall?</p><form method="post" action="/oauth/authorize">${hidden({ ...fields, intent: "allow" })}<button>Allow</button></form>`;
}

async function userForLogin(login: string, password: string): Promise<Awaited<ReturnType<typeof findUserByLogin>>> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  const user = await findUserByLogin(login);
  const ok = await verifyPassword(password, user ? user.password_hash : await dummyHash);
  return user && ok ? user : null;
}

export async function oauthAuthorize(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const form = request.method === "POST" ? await request.formData() : null;
  const field = (name: string) => String(form?.get(name) ?? url.searchParams.get(name) ?? "");
  const fields = {
    client_id: field("client_id"),
    redirect_uri: field("redirect_uri"),
    code_challenge: field("code_challenge"),
    code_challenge_method: field("code_challenge_method"),
    state: field("state"),
  };
  if (
    fields.code_challenge_method !== "S256" ||
    !fields.code_challenge ||
    !clientAllows(fields.client_id, fields.redirect_uri)
  ) {
    return page("Authorize", "<p>This client is not registered.</p>", 400);
  }

  let userId = sessionUser(request);
  if (field("intent") === "login") {
    const login = (field("login") || field("email")).trim().toLowerCase();
    const hit = limit({ key: `oauth|${clientIp(request)}|${login}`, ...presetFor("LOGIN") });
    if (!hit.allowed) return page("Sign in", "<p>Too many attempts.</p>", 429);
    const user = await userForLogin(login, field("password"));
    if (!user) return page("Sign in", loginForm(fields, "Username, password, or code did not match."), 401);
    if (user.mfa_enrolled) {
      const code = field("code");
      const step = user.totp_secret ? totpStep(user.totp_secret, code) : null;
      const totpOk = step !== null && (await claimTotpStep(user.id, step));
      const recoveryOk = !totpOk && (await consumeRecoveryCode(user.id, code));
      if (!totpOk && !recoveryOk) {
        return page("Sign in", loginForm(fields, "Username, password, or code did not match."), 401);
      }
    }
    userId = user.id;
  }

  if (!userId) return page("Sign in", loginForm(fields));
  if (field("intent") !== "allow") {
    const headers = new Headers();
    if (field("intent") === "login") headers.append("set-cookie", sessionCookie(userId, request));
    return page("Allow", allowForm(fields), 200, headers);
  }

  const exp = Math.floor(Date.now() / 1000) + CODE_SECONDS;
  const code = sign({
    k: "code",
    cid: fields.client_id,
    redir: fields.redirect_uri,
    ch: fields.code_challenge,
    jti: randomBytes(16).toString("hex"),
    exp,
  });
  if (!code) return page("Authorize", "<p>HEIMDALL_SESSION_SECRET is unset.</p>", 500);
  const target = new URL(fields.redirect_uri);
  target.searchParams.set("code", code);
  if (fields.state) target.searchParams.set("state", fields.state);
  return Response.redirect(target, 303);
}

function issued(clientId: string): Record<string, string | number> | null {
  const exp = Math.floor(Date.now() / 1000);
  const access = sign({ k: "access", cid: clientId, exp: exp + ACCESS_SECONDS });
  const refresh = sign({
    k: "refresh",
    cid: clientId,
    jti: randomBytes(16).toString("hex"),
    exp: exp + REFRESH_SECONDS,
  });
  if (!access || !refresh) return null;
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: "Bearer",
    expires_in: ACCESS_SECONDS,
  };
}

export async function oauthToken(request: Request): Promise<Response> {
  const form = await request.formData();
  const grant = String(form.get("grant_type") || "");
  const clientId = String(form.get("client_id") || "");
  if (grant === "authorization_code") {
    const payload = open(String(form.get("code") || ""));
    const verifier = String(form.get("code_verifier") || "");
    const redirectUri = String(form.get("redirect_uri") || "");
    if (
      !payload ||
      !fresh(payload, "code") ||
      payload.cid !== clientId ||
      payload.redir !== redirectUri ||
      payload.ch !== pkce(verifier) ||
      typeof payload.jti !== "string" ||
      !remember(payload.jti)
    ) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    const tokens = issued(clientId);
    return tokens
      ? Response.json(tokens)
      : Response.json({ error: "server_error" }, { status: 500 });
  }
  if (grant === "refresh_token") {
    const payload = open(String(form.get("refresh_token") || ""));
    if (
      !payload ||
      !fresh(payload, "refresh") ||
      payload.cid !== clientId ||
      typeof payload.jti !== "string" ||
      !remember(payload.jti)
    ) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    const tokens = issued(clientId);
    return tokens
      ? Response.json(tokens)
      : Response.json({ error: "server_error" }, { status: 500 });
  }
  return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
}
