import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import type { VulnSource } from "@/lib/db/types";
import { listFindings } from "@/lib/security/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireSession({ permission: "agents:read" });
    const url = new URL(request.url);
    const sourceRaw = url.searchParams.get("source");
    const source =
      sourceRaw === "trivy" ||
      sourceRaw === "osv" ||
      sourceRaw === "github" ||
      sourceRaw === "gitlab" ||
      sourceRaw === "host_posture" ||
      sourceRaw === "runtime"
        ? (sourceRaw as VulnSource)
        : undefined;
    const agentId = url.searchParams.get("agentId")?.trim() || undefined;
    const limit = Number(url.searchParams.get("limit") ?? 200);
    const findings = await listFindings(session.orgId!, {
      source,
      agentId,
      limit,
    });
    return NextResponse.json({
      findings: findings.map((f) => ({
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
