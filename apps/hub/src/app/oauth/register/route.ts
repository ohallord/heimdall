import { oauthRegister } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return oauthRegister(request);
}
