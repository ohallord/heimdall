import { NextResponse } from "next/server";
import { guardIngest } from "@/lib/http-guard/ingest";
import { authorizeAgentIngest } from "@/lib/agents/ingest-auth";
import { ingestAgentLogs } from "@/lib/logs/ingest";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guarded = await guardIngest(request, { name: "INGEST", route: "agents/logs", maxBytes: 2097152 });
  if (!guarded.ok) return guarded.response;
  const body = guarded.value;
  const record = (body ?? {}) as Record<string, unknown>;
  const agentId = typeof record.agentId === "string" ? record.agentId : "";
  const auth = await authorizeAgentIngest(request, agentId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const rawLines = Array.isArray(record.lines) ? record.lines : [];
  const lines = rawLines.map((item) => {
    const row = (item ?? {}) as Record<string, unknown>;
    return {
      source: typeof row.source === "string" ? row.source : "unknown",
      line: typeof row.line === "string" ? row.line : String(row.line ?? ""),
      observedAt:
        typeof row.observedAt === "string" ? row.observedAt : undefined,
    };
  });

  const result = await ingestAgentLogs({ agentId: auth.agent.id, lines });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(
    {
      accepted: true,
      lines: result.accepted,
      matches: result.matches,
      alertsFired: result.alertsFired,
    },
    { status: 202 },
  );
}
