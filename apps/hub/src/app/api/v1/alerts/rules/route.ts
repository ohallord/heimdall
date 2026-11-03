import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { ensureHostMetricRules } from "@/lib/metrics/ingest";
import { listAlertRules } from "@/lib/db/store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireSession({ permission: "agents:read" });
    const orgId = session.orgId!;
    await ensureHostMetricRules(orgId);
    const rules = await listAlertRules(orgId);
    return NextResponse.json({
      rules: rules.map((r) => ({
        id: r.id,
        name: r.name,
        metric: r.metric,
        operator: r.operator,
        threshold: r.threshold,
        warnThreshold: r.warn_threshold,
        alarmThreshold: r.alarm_threshold ?? r.threshold,
        enabled: r.enabled,
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
