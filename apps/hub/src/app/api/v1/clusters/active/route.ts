import { mutating } from "@/lib/http-guard/mutating";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { setActiveCluster } from "@/lib/clusters/store";

export const dynamic = "force-dynamic";

const schema = z.object({
  clusterId: z.string().min(1).max(64),
});

async function postHandler(request: Request) {
  try {
    const session = await requireSession({ permission: "settings:write" });
    const body = schema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
    }
    const settings = await setActiveCluster(
      session.orgId!,
      body.data.clusterId,
    );
    return NextResponse.json({
      activeClusterId: settings.active_cluster_id,
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
