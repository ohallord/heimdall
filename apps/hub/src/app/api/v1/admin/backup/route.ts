import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { buildOrgBackup } from "@/lib/backup/export";
import { restoreOrgBackup, type RestoreResult } from "@/lib/backup/restore";
import type { BackupPayload } from "@/lib/backup/export";
import { readJsonLimited } from "@/lib/http-guard/body";
import { rejectBlockedUrls } from "@/lib/http-guard/validate-url";
import { smtpProbeUrl } from "@/lib/alerts/channels";
import { apiError } from "@/lib/http-guard/api-error";

export const dynamic = "force-dynamic";

const MAX_RESTORE_BYTES = 5 * 1024 * 1024;
const config = z.record(z.string(), z.unknown());
const restoreSchema = z.object({
  backup: z.object({
    version: z.literal(1),
    exportedAt: z.string().optional(),
    orgId: z.string().optional(),
    includeSecrets: z.boolean().optional(),
    clusters: z
      .array(z.object({ clusterId: z.string().min(1).max(200), name: z.string().max(200).optional() }).passthrough())
      .max(1000)
      .optional(),
    settings: z.object({ activeClusterId: z.string().max(200).nullish() }).passthrough().optional(),
    users: z.array(z.unknown()).optional(), // exported for reference; never restored
    alertChannels: z
      .array(
        z.object({
          kind: z.enum(["smtp", "slack", "discord", "sms"]),
          enabled: z.boolean().optional(),
          config,
        }),
      )
      .max(100)
      .optional(),
    alertRules: z
      .array(
        z.object({
          name: z.string().max(200),
          metric: z.string().max(200),
          operator: z.enum([">", ">=", "<", "<="]),
          threshold: z.number().nullish(),
          warnThreshold: z.number().nullish(),
          alarmThreshold: z.number().nullish(),
          enabled: z.boolean(),
        }).passthrough(),
      )
      .max(1000)
      .optional(),
    remotes: z
      .array(
        z.object({
          kind: z.enum(["github", "gitlab"]),
          name: z.string().min(1).max(200),
          enabled: z.boolean().optional(),
          tokenHint: z.string().max(64).nullish(),
          config,
        }),
      )
      .max(100)
      .optional(),
    oidcProviders: z
      .array(
        z.object({
          name: z.string().min(1).max(200),
          issuer: z.string().url().max(2048),
          clientId: z.string().min(1).max(512),
          clientSecret: z.string().max(4096).nullish(),
          scopes: z.string().max(512).optional(),
          enabled: z.boolean().optional(),
        }).passthrough(),
      )
      .max(20)
      .optional(),
    agents: z.array(z.unknown()).optional(),
  }),
});

/** Every outbound target in a backup, so restore applies the same SSRF rule as the settings forms. */
function restoreUrls(b: z.infer<typeof restoreSchema>["backup"]): string[] {
  const out: string[] = [];
  const str = (v: unknown) => (typeof v === "string" && v && v !== "[redacted]" ? v : null);
  for (const ch of b.alertChannels ?? []) {
    const url = str(ch.config.url);
    if (url) out.push(url);
    const api = str(ch.config.apiBaseUrl);
    if (api) out.push(api);
    const host = str(ch.config.host);
    if (ch.kind === "smtp" && host) out.push(smtpProbeUrl(host, Number(ch.config.port) || undefined));
  }
  for (const r of b.remotes ?? []) {
    const api = str(r.config.apiBaseUrl);
    if (api) out.push(api);
  }
  for (const p of b.oidcProviders ?? []) out.push(p.issuer);
  return out;
}

export async function GET(request: Request) {
  try {
    const session = await requireSession({ permission: "settings:write" });
    const url = new URL(request.url);
    const includeSecrets = url.searchParams.get("includeSecrets") === "1";
    if (includeSecrets) {
      console.warn(`[heimdall] audit: user ${session.userId} exported org ${session.orgId} backup WITH secrets`);
    }
    const backup = await buildOrgBackup({
      orgId: session.orgId!,
      includeSecrets,
    });
    return NextResponse.json({ backup });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return apiError(err, status);
  }
}

async function postHandler(request: Request) {
  try {
    const session = await requireSession({ permission: "settings:write" });
    const raw = await readJsonLimited(request, MAX_RESTORE_BYTES);
    if (!raw.ok) {
      return NextResponse.json({ error: raw.status === 413 ? "payload_too_large" : "invalid JSON body" }, { status: raw.status });
    }
    const body = restoreSchema.safeParse(raw.value);
    if (!body.success) {
      return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
    }
    const blocked = await rejectBlockedUrls(restoreUrls(body.data.backup));
    if (blocked) return blocked;
    const result: RestoreResult = await restoreOrgBackup({
      orgId: session.orgId!,
      backup: body.data.backup as BackupPayload,
    });
    return NextResponse.json({ restored: result });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return apiError(err, status);
  }
}

export const POST = mutating(postHandler);
