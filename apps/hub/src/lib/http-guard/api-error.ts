import { NextResponse } from "next/server";

/**
 * JSON error for a caught exception. Errors the hub throws on purpose carry a `status` and a
 * safe message ("unauthorized", "forbidden", "mfa_required", config hints). Anything else is
 * unexpected: its message may hold driver or upstream detail, so it is logged here and the
 * client only sees "internal_error".
 */
export function apiError(err: unknown, status?: number): NextResponse {
  const own = (err as { status?: unknown })?.status;
  if (typeof own !== "number") {
    console.error("[heimdall] request failed:", err);
    return NextResponse.json({ error: "internal_error" }, { status: status && status < 500 ? status : 500 });
  }
  return NextResponse.json(
    { error: err instanceof Error ? err.message : "error" },
    { status: status ?? own },
  );
}
