import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/http-guard/api-error";
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import {
  getLogsRetentionDays,
  getMetricsRetentionDays,
  getTracesRetentionDays,
  setLogsRetentionDays,
  setMetricsRetentionDays,
  setTracesRetentionDays,
} from "@/lib/metrics/retention";
import {
  getCriticalFindingsToAlarms,
  setCriticalFindingsToAlarms,
} from "@/lib/security/settings";

export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    metricsRetentionDays: z.number().finite().optional(),
    logsRetentionDays: z.number().finite().optional(),
    tracesRetentionDays: z.number().finite().optional(),
    criticalFindingsToAlarms: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.metricsRetentionDays !== undefined ||
      v.logsRetentionDays !== undefined ||
      v.tracesRetentionDays !== undefined ||
      v.criticalFindingsToAlarms !== undefined,
    { message: "at least one setting required" },
  );

export async function GET() {
  try {
    const session = await requireSession({ permission: "agents:read" });
    const orgId = session.orgId!;
    const [
      metricsRetentionDays,
      logsRetentionDays,
      tracesRetentionDays,
      criticalFindingsToAlarms,
    ] = await Promise.all([
        getMetricsRetentionDays(orgId),
        getLogsRetentionDays(orgId),
        getTracesRetentionDays(orgId),
        getCriticalFindingsToAlarms(orgId),
      ]);
    return NextResponse.json({
      metricsRetentionDays,
      logsRetentionDays,
      tracesRetentionDays,
      criticalFindingsToAlarms,
    });
  } catch (err) {
    return apiError(err);
  }
}

async function patchHandler(request: Request) {
  try {
    const session = await requireSession({ permission: "alerts:write" });
    const orgId = session.orgId!;
    const body = patchSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
    }

    let metricsRetentionDays = await getMetricsRetentionDays(orgId);
    let logsRetentionDays = await getLogsRetentionDays(orgId);
    let tracesRetentionDays = await getTracesRetentionDays(orgId);
    let criticalFindingsToAlarms = await getCriticalFindingsToAlarms(orgId);

    if (body.data.logsRetentionDays !== undefined) {
      logsRetentionDays = await setLogsRetentionDays(
        orgId,
        body.data.logsRetentionDays,
      );
    }
    if (body.data.tracesRetentionDays !== undefined) {
      tracesRetentionDays = await setTracesRetentionDays(
        orgId,
        body.data.tracesRetentionDays,
      );
    }
    if (body.data.metricsRetentionDays !== undefined) {
      metricsRetentionDays = await setMetricsRetentionDays(
        orgId,
        body.data.metricsRetentionDays,
      );
    }
    if (body.data.criticalFindingsToAlarms !== undefined) {
      criticalFindingsToAlarms = await setCriticalFindingsToAlarms(
        orgId,
        body.data.criticalFindingsToAlarms,
      );
    }

    return NextResponse.json({
      metricsRetentionDays,
      logsRetentionDays,
      tracesRetentionDays,
      criticalFindingsToAlarms,
    });
  } catch (err) {
    return apiError(err);
  }
}

export const PATCH = mutating(patchHandler);
