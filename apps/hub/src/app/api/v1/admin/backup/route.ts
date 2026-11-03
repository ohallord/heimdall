import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { buildOrgBackup } from "@/lib/backup/export";
import { restoreOrgBackup, type RestoreResult } from "@/lib/backup/restore";
import type { BackupPayload } from "@/lib/backup/export";

export const dynamic = "force-dynamic";

const restoreSchema = z.object({
  backup: z.object({
    version: z.literal(1),
    exportedAt: z.string().optional(),
    orgId: z.string().optional(),
    includeSecrets: z.boolean().optional(),
    clusters: z.array(z.any()).optional(),
    settings: z.any().optional(),
    users: z.array(z.any()).optional(),
    alertChannels: z.array(z.any()).optional(),
    alertRules: z.array(z.any()).optional(),
    remotes: z.array(z.any()).optional(),
    oidcProviders: z.array(z.any()).optional(),
    agents: z.array(z.any()).optional(),
  }),
});

export async function GET(request: Request) {
  try {
    const session = await requireSession({ permission: "settings:write" });
    const url = new URL(request.url);
    const includeSecrets = url.searchParams.get("includeSecrets") === "1";
    const backup = await buildOrgBackup({
      orgId: session.orgId!,
      includeSecrets,
    });
    return NextResponse.json({ backup });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status },
    );
  }
}

async function postHandler(request: Request) {
  try {
    const session = await requireSession({ permission: "settings:write" });
    const body = restoreSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
    }
    const result: RestoreResult = await restoreOrgBackup({
      orgId: session.orgId!,
      backup: body.data.backup as BackupPayload,
    });
    return NextResponse.json({ restored: result });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status },
    );
  }
}

export const POST = mutating(postHandler);
