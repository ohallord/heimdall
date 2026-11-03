import { NextResponse } from "next/server";
import { getSetupState, isSetupComplete } from "@/lib/db/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const complete = await isSetupComplete();
  const state = await getSetupState();
  return NextResponse.json({
    complete,
    currentStep: state.current_step,
  });
}
