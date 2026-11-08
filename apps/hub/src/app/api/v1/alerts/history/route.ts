import { NextResponse } from "next/server";
import { apiError } from "@/lib/http-guard/api-error";
import { serializeAlertEvent } from "@/lib/alerts/serialize";
import { requireSession } from "@/lib/auth/session";
import { listAlertEvents } from "@/lib/db/store";
import type { AlertEventStatus } from "@/lib/db/types";

export const dynamic = "force-dynamic";

const STATUS_VALUES = new Set<AlertEventStatus>([
  "open",
  "muted",
  "dismissed",
]);

export async function GET(request: Request) {
  try {
    const session = await requireSession({ permission: "alerts:read" });
    const url = new URL(request.url);
    const limit = Math.min(
      200,
      Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50),
    );
    const id = url.searchParams.get("id") ?? undefined;
    const statusParam = url.searchParams.get("status");
    let status: AlertEventStatus | "open_queue" | undefined;
    if (statusParam === "open_queue" || statusParam === "queue") {
      status = "open_queue";
    } else if (statusParam && STATUS_VALUES.has(statusParam as AlertEventStatus)) {
      status = statusParam as AlertEventStatus;
    }

    const events = await listAlertEvents(session.orgId!, {
      limit,
      id,
      status,
    });
    return NextResponse.json({
      events: events.map((e) => serializeAlertEvent(e)),
    });
  } catch (err) {
    return apiError(err);
  }
}
