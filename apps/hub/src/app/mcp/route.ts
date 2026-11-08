import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authorizeMcpRequest } from "@/lib/mcp/auth";
import { createHeimdallMcpServer } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";

/**
 * Stateless streamable HTTP. Each POST is one JSON-RPC call; there is no session
 * store. GET and DELETE are omitted: a stateless server has no standalone SSE
 * stream and no session to terminate (Next.js answers those methods with 405).
 * Auth runs before the transport. Session cookies are not consulted.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = authorizeMcpRequest(request);
  if (!auth.ok) return auth.response;

  const server = createHeimdallMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request);
    // Buffer before close so tearing down the stateless server cannot cancel the body.
    const body = await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    await server.close().catch(() => undefined);
  }
}
