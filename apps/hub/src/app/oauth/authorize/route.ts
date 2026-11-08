import { oauthAuthorize } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return oauthAuthorize(request);
}

export function POST(request: Request) {
  return oauthAuthorize(request);
}
