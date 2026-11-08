import { oauthToken } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return oauthToken(request);
}
