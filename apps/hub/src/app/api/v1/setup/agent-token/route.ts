import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { createAgentToken, setSetupStep } from "@/lib/db/store";
import { buildInstallSnippets } from "@/lib/wizard/snippets";

export const dynamic = "force-dynamic";

function hubUrlFromRequest(request: Request): string {
  const env = process.env.HEIMDALL_PUBLIC_URL;
  if (env) return env.replace(/\/$/, "");
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

async function postHandler(request: Request) {
  try {
    const session = await requireSession({
      permission: "setup:run",
      requireMfa: false,
    });

    const { token, row } = await createAgentToken({
      orgId: session.orgId!,
      name: "First agent token",
      createdBy: session.userId,
    });

    const snippets = buildInstallSnippets({
      hubUrl: hubUrlFromRequest(request),
      token,
    });

    await setSetupStep("remotes");

    return NextResponse.json({
      tokenId: row.id,
      token,
      tokenHint: row.token_hint,
      snippets,
      nextStep: "remotes",
    });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status },
    );
  }
}

export const POST = mutating(postHandler);
