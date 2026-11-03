import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { rejectBlockedUrls } from "@/lib/http-guard/validate-url";
import {
  listSecurityConnections,
  upsertSecurityConnection,
} from "@/lib/security/store";

export const dynamic = "force-dynamic";

const schema = z.object({
  kind: z.enum(["github", "gitlab"]),
  name: z.string().min(1),
  token: z.string().min(1),
  org: z.string().optional(),
  projectPath: z.string().optional(),
  apiBaseUrl: z.string().url().optional(),
  enabled: z.boolean().optional(),
});

function hint(token: string): string {
  if (token.length <= 8) return "****";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

export async function GET() {
  try {
    const session = await requireSession({ permission: "agents:read" });
    const rows = await listSecurityConnections(session.orgId!);
    return NextResponse.json({
      connections: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        name: r.name,
        tokenHint: r.token_hint,
        enabled: r.enabled,
        config: redactConfig(JSON.parse(r.config_json)),
      })),
    });
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
    const body = schema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
    }
    const blocked = await rejectBlockedUrls([body.data.apiBaseUrl]);
    if (blocked) return blocked;
    const config: Record<string, unknown> = {
      token: body.data.token,
    };
    if (body.data.org) config.org = body.data.org;
    if (body.data.projectPath) config.projectPath = body.data.projectPath;
    if (body.data.apiBaseUrl) config.apiBaseUrl = body.data.apiBaseUrl;

    const row = await upsertSecurityConnection({
      orgId: session.orgId!,
      kind: body.data.kind,
      name: body.data.name,
      config,
      tokenHint: hint(body.data.token),
      enabled: body.data.enabled,
    });
    return NextResponse.json({
      connection: {
        id: row.id,
        kind: row.kind,
        name: row.name,
        tokenHint: row.token_hint,
        enabled: row.enabled,
      },
    });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status },
    );
  }
}

function redactConfig(config: Record<string, unknown>) {
  const rest = { ...config };
  delete rest.token;
  return rest;
}

export const POST = mutating(postHandler);
