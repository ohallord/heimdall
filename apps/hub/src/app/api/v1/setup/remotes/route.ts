import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { rejectBlockedUrls } from "@/lib/http-guard/validate-url";
import { setSetupStep } from "@/lib/db/store";
import { upsertSecurityConnection } from "@/lib/security/store";

export const dynamic = "force-dynamic";

const schema = z.object({
  github: z
    .object({
      org: z.string().min(1),
      token: z.string().min(1),
      apiBaseUrl: z.string().url().optional(),
    })
    .optional(),
  gitlab: z
    .object({
      projectPath: z.string().min(1),
      token: z.string().min(1),
      apiBaseUrl: z.string().url().optional(),
    })
    .optional(),
  skip: z.boolean().optional(),
});

function hint(token: string): string {
  if (token.length <= 8) return "****";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

async function postHandler(request: Request) {
  try {
    const session = await requireSession({
      permission: "setup:run",
      requireMfa: false,
    });
    const body = schema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
    }

    const blocked = await rejectBlockedUrls([
      body.data.github?.apiBaseUrl,
      body.data.gitlab?.apiBaseUrl,
    ]);
    if (blocked) return blocked;

    if (body.data.github) {
      await upsertSecurityConnection({
        orgId: session.orgId!,
        kind: "github",
        name: body.data.github.org,
        tokenHint: hint(body.data.github.token),
        config: {
          token: body.data.github.token,
          org: body.data.github.org,
          apiBaseUrl: body.data.github.apiBaseUrl,
        },
      });
    }

    if (body.data.gitlab) {
      await upsertSecurityConnection({
        orgId: session.orgId!,
        kind: "gitlab",
        name: body.data.gitlab.projectPath,
        tokenHint: hint(body.data.gitlab.token),
        config: {
          token: body.data.gitlab.token,
          projectPath: body.data.gitlab.projectPath,
          apiBaseUrl: body.data.gitlab.apiBaseUrl,
        },
      });
    }

    await setSetupStep("mfa");
    return NextResponse.json({ nextStep: "mfa" });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "error" },
      { status },
    );
  }
}

export const POST = mutating(postHandler);
