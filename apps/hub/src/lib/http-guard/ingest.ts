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

/** Bucket key: short hash of the presented token (never the raw token), else client IP. */
export function ingestKey(request: Request, route: string): string {
  const token = extractBearerOrHeaderToken(request);
  const who = token
    ? `t:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`
    : `ip:${clientIp(request)}`;
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
