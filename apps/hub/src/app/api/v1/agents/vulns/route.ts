import { NextResponse } from "next/server";
import { guardIngest } from "@/lib/http-guard/ingest";
import { authorizeAgentIngest } from "@/lib/agents/ingest-auth";
import { ingestSecurityScan, type ScanKind } from "@/lib/security/sync";

export const dynamic = "force-dynamic";

function parseScanKind(raw: unknown): ScanKind {
  if (raw === "host_posture") return "host_posture";
  return "image";
}

/** Agent-facing Trivy/OSV report ingest — requires agent/bootstrap token. */
export async function POST(request: Request) {
  const guarded = await guardIngest(request, { name: "INGEST", route: "agents/vulns", maxBytes: 10485760 });
  if (!guarded.ok) return guarded.response;
  const body = guarded.value;
  const record = (body ?? {}) as Record<string, unknown>;
  const agentId = typeof record.agentId === "string" ? record.agentId.trim() : "";
  const auth = await authorizeAgentIngest(request, agentId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const scanKind = parseScanKind(record.scanKind);
  const result = await ingestSecurityScan({
    orgId: auth.orgId,
    trivyReport: record.trivyReport,
    osvReport: record.osvReport,
    scanKind,
    agentId: auth.agent.id,
  });

  return NextResponse.json(
    { accepted: true, agentId: auth.agent.id, scanKind, ...result },
    { status: 202 },
  );
}
