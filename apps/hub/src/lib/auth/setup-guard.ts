import { NextResponse } from "next/server";
import { isSetupComplete } from "@/lib/db/store";

/**
 * Setup-wizard routes accept a password-only admin session (MFA is enrolled at the end of the
 * wizard). Once setup is complete they must refuse, or they become an MFA bypass.
 */
export async function setupClosed(): Promise<Response | null> {
  if (await isSetupComplete()) {
    return NextResponse.json(
      { error: "setup already complete; use Settings instead" },
      { status: 409 },
    );
  }
  return null;
}
