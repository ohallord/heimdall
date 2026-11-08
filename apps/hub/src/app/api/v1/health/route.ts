import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "heimdall-hub",
    phase: 8,
    time: new Date().toISOString(),
  });
}
