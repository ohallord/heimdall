import { createHash } from "node:crypto";
import { readJsonLimited } from "./body";
import { clientIp, limit, presetFor, tooMany, type RateName } from "./rate-limit";
import { extractBearerOrHeaderToken } from "@/lib/integrations/tokens";

export type IngestGuardOptions = {
  /** Rate-limit preset (HEIMDALL_RATE_<NAME> override). */
  name: Extract<RateName, "INGEST" | "REGISTER" | "WEBHOOK">;
  /** Route label, keeps buckets separate per route. */
  route: string;
  /** Default body cap in bytes; `HEIMDALL_MAX_BODY_<NAME>` (bytes) overrides. */
  maxBytes: number;
};

function bodyCap(o: IngestGuardOptions): number {
  const n = Number(process.env[`HEIMDALL_MAX_BODY_${o.name}`]);
  return Number.isFinite(n) && n > 0 ? n : o.maxBytes;
}

const KNOWN = Symbol.for("heimdall.knownIngestTokens");
const MAX_KNOWN = 10_000;
type Holder = { [KNOWN]?: Set<string> };

/** Tokens that have authenticated at least once (hash prefixes only). Shared across bundles. */
function known(): Set<string> {
  const g = globalThis as Holder;
  return (g[KNOWN] ??= new Set());
}

function tokenTag(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/** Record a token that just authenticated, so it gets its own rate-limit bucket from now on. */
export function rememberValidToken(token: string | null | undefined): void {
  if (!token) return;
  const set = known();
  const tag = tokenTag(token);
  if (set.has(tag)) return;
  if (set.size >= MAX_KNOWN) set.delete(set.values().next().value as string);
  set.add(tag);
}

export function forgetKnownTokens(): void {
  known().clear();
}

/**
 * Bucket key. A token that has authenticated before gets its own bucket. Anything else (no
 * token, or one never seen to work) shares the per-client-IP bucket, so rotating random
 * tokens cannot mint a fresh budget per request.
 */
export function ingestKey(request: Request, route: string): string {
  const token = extractBearerOrHeaderToken(request);
  const tag = token ? tokenTag(token) : null;
  const who = tag && known().has(tag) ? `t:${tag}` : `ip:${clientIp(request)}`;
  return `${route}|${who}`;
}

/** Rate limit only. Returns a 429 Response, or null if allowed. */
export function guardRate(request: Request, o: Pick<IngestGuardOptions, "name" | "route">): Response | null {
  const r = limit({ key: ingestKey(request, o.route), ...presetFor(o.name) });
  return r.allowed ? null : tooMany(r.retryAfter);
}

/** Size-capped JSON read. Returns the parsed value, or a 400/413 Response. */
export async function guardBody(
  request: Request,
  o: IngestGuardOptions,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const r = await readJsonLimited(request, bodyCap(o));
  if (r.ok) return r;
  const error = r.status === 413 ? "payload_too_large" : "invalid JSON body";
  return { ok: false, response: Response.json({ error }, { status: r.status }) };
}

/** Rate-limit, then read body. For routes whose auth needs the body (agents/*). */
export async function guardIngest(
  request: Request,
  o: IngestGuardOptions,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const limited = guardRate(request, o);
  if (limited) return { ok: false, response: limited };
  return guardBody(request, o);
}
