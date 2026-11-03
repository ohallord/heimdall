import { NextResponse } from "next/server";
import { guardIngest } from "@/lib/http-guard/ingest";
import { registerAgent } from "@/lib/agents";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guarded = await guardIngest(request, { name: "REGISTER", route: "agents/register", maxBytes: 65536 });
  if (!guarded.ok) return guarded.response;
  const body = guarded.value;

  const record = (body ?? {}) as Record<string, unknown>;
  const result = await registerAgent({
    token: typeof record.token === "string" ? record.token : "",
    hostname: typeof record.hostname === "string" ? record.hostname : "",
    version: typeof record.version === "string" ? record.version : "",
    agentSecret: typeof record.agentSecret === "string" ? record.agentSecret : undefined,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(
    {
      agentId: result.agent.id,
      hostname: result.agent.hostname,
      version: result.agent.version,
      registeredAt: result.agent.registeredAt,
      protocol: "heimdall.handshake.v0",
      ...(result.agentSecret ? { agentSecret: result.agentSecret } : {}),
    },
    { status: 201 },
  );
}
