import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { searchLogEvents } from "@/lib/logs/ingest";
import { DEFAULT_LOG_RULES } from "@/lib/logs/rules";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireSession({ permission: "agents:read" });
    const url = new URL(request.url);
    const q = url.searchParams.get("q") ?? undefined;
    const ruleId = url.searchParams.get("rule") ?? undefined;
    const agentId = url.searchParams.get("agentId") ?? undefined;
    const matchesOnly = url.searchParams.get("matchesOnly") === "1";
    const limit = Number(url.searchParams.get("limit") ?? 50);

    const events = await searchLogEvents({
      orgId: session.orgId!,
      q,
      ruleId,
      agentId,
      matchesOnly,
      limit,
    });

    return NextResponse.json({
      rules: DEFAULT_LOG_RULES.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        severity: r.severity,
      })),
      events: events.map((e) => ({
        id: e.id,
        agentId: e.agent_id,
        source: e.source,
        line: e.line,
        observedAt: new Date(e.observed_at).toISOString(),
        severity: e.severity,
        matches: e.matches,
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
