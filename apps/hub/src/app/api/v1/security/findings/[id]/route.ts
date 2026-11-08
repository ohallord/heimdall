import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/http-guard/api-error";
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { getFinding, resolveFinding } from "@/lib/security/store";

export const dynamic = "force-dynamic";

function serializeFinding(f: Awaited<ReturnType<typeof getFinding>>) {
  if (!f) return null;
  let raw: unknown = {};
  try {
    raw = JSON.parse(f.raw_json || "{}");
  } catch {
    raw = {};
  }
  return {
    id: f.id,
    source: f.source,
    externalId: f.external_id,
    title: f.title,
    severity: f.severity,
    packageName: f.package_name,
    packageVersion: f.package_version,
    fixedVersion: f.fixed_version,
    resource: f.resource,
    cve: f.cve,
    url: f.url,
    status: f.status,
    agentId: f.agent_id,
    firstSeenAt: new Date(f.first_seen_at).toISOString(),
    lastSeenAt: new Date(f.last_seen_at).toISOString(),
    resolvedAt: f.resolved_at
      ? new Date(f.resolved_at).toISOString()
      : null,
    raw,
  };
}

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireSession({ permission: "agents:read" });
    const { id } = await ctx.params;
    const finding = await getFinding(session.orgId!, id);
    if (!finding) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ finding: serializeFinding(finding) });
  } catch (err) {
    return apiError(err);
  }
}

const patchSchema = z.object({
  status: z.literal("resolved"),
});

async function patchHandler(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireSession({ permission: "alerts:write" });
    const { id } = await ctx.params;
    const body = patchSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
    }
    const finding = await resolveFinding(session.orgId!, id);
    if (!finding) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ finding: serializeFinding(finding) });
  } catch (err) {
    return apiError(err);
  }
}

export const PATCH = mutating(patchHandler);
