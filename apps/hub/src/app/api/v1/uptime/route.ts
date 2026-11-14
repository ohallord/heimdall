import { NextResponse } from "next/server";
import { z } from "zod";
import { recordAudit } from "@/lib/audit/log";
import { requireSession } from "@/lib/auth/session";
import { apiError } from "@/lib/http-guard/api-error";
import { mutating } from "@/lib/http-guard/mutating";
import { rejectBlockedUrls } from "@/lib/http-guard/validate-url";
import { resolveUptimeAlarmSilently } from "@/lib/uptime/monitor";
import {
  createUptimeCheck,
  deleteUptimeCheck,
  getUptimeCheck,
  guardUrlFor,
  listUptimeChecks,
  setUptimeCheckEnabled,
  toView,
  validateUptimeInput,
} from "@/lib/uptime/store";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["http", "tcp", "tls"]),
  target: z.string().trim().min(1).max(500),
  intervalSeconds: z.number().int().optional(),
  timeoutMs: z.number().int().optional(),
  expectedStatus: z.number().int().nullable().optional(),
  tlsWarnDays: z.number().int().optional(),
  enabled: z.boolean().optional(),
});

const patchSchema = z.object({ id: z.string().min(1), enabled: z.boolean() });

/** GET /api/v1/uptime — the org's checks with their last result. */
export async function GET() {
  try {
    const session = await requireSession({ permission: "agents:read" });
    const rows = await listUptimeChecks(session.orgId!);
    return NextResponse.json({ checks: rows.map(toView) });
  } catch (err) {
    return apiError(err);
  }
}

/** POST — add a check. Private targets are refused unless HEIMDALL_ALLOW_PRIVATE_HOSTS allows them. */
async function postHandler(request: Request) {
  try {
    const session = await requireSession({ permission: "alerts:write" });
    const body = createSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
    const problem = validateUptimeInput(body.data);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    const blocked = await rejectBlockedUrls([guardUrlFor(body.data)]);
    if (blocked) return blocked;
    const row = await createUptimeCheck(session.orgId!, { ...body.data, createdBy: session.userId ?? null });
    await recordAudit({
      session,
      request,
      action: "uptime.check.create",
      target: row.id,
      detail: { name: row.name, kind: row.kind, target: row.target, intervalSeconds: row.interval_seconds },
    });
    return NextResponse.json({ check: toView(row) }, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}

/** PATCH { id, enabled } — pause or resume a check. */
async function patchHandler(request: Request) {
  try {
    const session = await requireSession({ permission: "alerts:write" });
    const body = patchSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return NextResponse.json({ error: "id and enabled required" }, { status: 400 });
    const row = await setUptimeCheckEnabled(session.orgId!, body.data.id, body.data.enabled);
    if (!row) return NextResponse.json({ error: "check not found" }, { status: 404 });
    if (!body.data.enabled) await resolveUptimeAlarmSilently(session.orgId!, row.id);
    await recordAudit({
      session,
      request,
      action: "uptime.check.update",
      target: row.id,
      detail: { name: row.name, enabled: row.enabled },
    });
    return NextResponse.json({ check: toView(row) });
  } catch (err) {
    return apiError(err);
  }
}

/** DELETE ?id= — remove a check (its open alarm is closed without a notification). */
async function deleteHandler(request: Request) {
  try {
    const session = await requireSession({ permission: "alerts:write" });
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) return NextResponse.json({ error: "id query parameter required" }, { status: 400 });
    const existing = await getUptimeCheck(session.orgId!, id);
    if (!existing) return NextResponse.json({ error: "check not found" }, { status: 404 });
    await resolveUptimeAlarmSilently(session.orgId!, id);
    await deleteUptimeCheck(session.orgId!, id);
    await recordAudit({
      session,
      request,
      action: "uptime.check.delete",
      target: id,
      detail: { name: existing.name, kind: existing.kind, target: existing.target },
    });
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return apiError(err);
  }
}

export const POST = mutating(postHandler);
export const PATCH = mutating(patchHandler);
export const DELETE = mutating(deleteHandler);
