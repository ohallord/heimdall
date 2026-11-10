import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAgent } from "@/lib/agents";
import { resetDbForTests } from "@/lib/db/client";
import { ingestAgentMetrics } from "@/lib/metrics/ingest";
import type { ContainerMetric, K8sPodMetric } from "@/lib/db/types";
import { POST } from "@/app/mcp/route";
import { wwwAuthenticate } from "./oauth";
import { authorizeMcpRequest } from "./auth";
import { createHeimdallMcpServer, HEIMDALL_MCP_TOOLS } from "./server";

const SENSITIVE_KEY = /token|secret|authorization/i;

function collectKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, found);
    return found;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      found.push(key);
      collectKeys(child, found);
    }
  }
  return found;
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const server = createHeimdallMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "heimdall-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function mcpRequest(url: string, headers: Record<string, string>, body?: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("heimdall mcp", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "test-token";
    delete process.env.DATABASE_URL;
    delete process.env.HEIMDALL_MCP_TOKEN;
    delete process.env.HEIMDALL_MCP_ALLOWED_HOSTS;
    resetDbForTests();
  });

  it("registers exactly the five read-only tools", async () => {
    const names = await withClient(async (client) => {
      const listed = await client.listTools();
      return listed.tools.map((tool) => tool.name);
    });
    expect(names).toEqual([...HEIMDALL_MCP_TOOLS]);
  });

  it("agent tool result has no token, secret, or authorization field", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const registered = await registerAgent({
      token: "test-token",
      hostname: "edge-01",
      version: "0.1.0",
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const ingested = await ingestAgentMetrics({
      agentId: registered.agent.id,
      cpuPercent: 12,
      memPercent: 34,
      containerRuntime: "docker",
      containers: [
        {
          id: "c1",
          name: "web",
          image: "img",
          state: "running",
          status: "up",
          restartCount: 0,
          token: "leak-token-value",
          secret: "leak-secret-value",
          authorization: "Bearer leak",
        } as ContainerMetric,
      ],
      kubernetes: {
        enabled: true,
        clusterId: "default",
        apiServerReachable: true,
        nodesTotal: 1,
        nodesReady: 1,
        podsPending: 0,
        podsCrashLoop: 0,
        deploymentsTotal: 0,
        deploymentsUnhealthy: 0,
        pods: [
          {
            namespace: "default",
            name: "web",
            phase: "Running",
            ready: "1/1",
            restarts: 0,
            healthy: true,
            logTail: "secret log body should not leak",
            token: "pod-token",
          } as K8sPodMetric,
        ],
      },
    });
    expect(ingested.ok).toBe(true);

    const result = await withClient((client) =>
      client.callTool({
        name: "heimdall_agent",
        arguments: { hostname: "edge-01" },
      }),
    );
    const text = result.content?.find((part) => part.type === "text")?.text ?? "";
    const payload = JSON.parse(text) as { ok?: boolean; metrics?: { cpuPercent?: number } };
    expect(payload.ok).toBe(true);
    expect(Number(payload.metrics?.cpuPercent)).toBe(12);
    expect(collectKeys(payload).filter((key) => SENSITIVE_KEY.test(key))).toEqual([]);
    expect(text).not.toContain("leak-token-value");
    expect(text).not.toContain("leak-secret-value");
    expect(text).not.toContain("Bearer leak");
    expect(text).not.toContain("pod-token");
    expect(text).not.toContain("secret log body should not leak");
    vi.unstubAllGlobals();
  });

  it("bearer check: unset token rejects a non-local host; wrong bearer is 401; correct bearer passes", async () => {
    const unset = authorizeMcpRequest(new Request("http://hub.example/mcp"));
    expect(unset.ok).toBe(false);
    if (!unset.ok) {
      expect(unset.response.status).toBe(401);
      expect(unset.response.headers.get("WWW-Authenticate")).toBe(
        wwwAuthenticate(new Request("http://hub.example/mcp")),
      );
    }

    const cookieOnly = await POST(
      mcpRequest("http://hub.example/mcp", { cookie: "heimdall_session=not-a-bearer" }),
    );
    expect(cookieOnly.status).toBe(401);
    expect(cookieOnly.headers.get("WWW-Authenticate")).toBe(
      wwwAuthenticate(mcpRequest("http://hub.example/mcp", {})),
    );

    process.env.HEIMDALL_MCP_TOKEN = "correct-token-value";
    const wrong = await POST(
      mcpRequest("http://127.0.0.1/mcp", { authorization: "Bearer wrong" }),
    );
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("WWW-Authenticate")).toBe(
      wwwAuthenticate(mcpRequest("http://127.0.0.1/mcp", {})),
    );

    const right = await POST(
      mcpRequest("http://127.0.0.1/mcp", { authorization: "Bearer correct-token-value" }, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      }),
    );
    expect(right.status).not.toBe(401);
    expect(right.status).toBe(200);
    const body = (await right.json()) as { result?: { serverInfo?: { name?: string } } };
    expect(body.result?.serverInfo?.name).toBe("heimdall");

    process.env.HEIMDALL_MCP_ALLOWED_HOSTS = "hub.lan";
    const deniedHost = authorizeMcpRequest(
      new Request("http://evil.example/mcp", {
        headers: { authorization: "Bearer correct-token-value" },
      }),
    );
    expect(deniedHost.ok).toBe(false);
    const allowedHost = authorizeMcpRequest(
      new Request("http://hub.lan:43123/mcp", {
        headers: { authorization: "Bearer correct-token-value" },
      }),
    );
    expect(allowedHost.ok).toBe(true);
    const localStill = authorizeMcpRequest(
      new Request("http://127.0.0.1/mcp", {
        headers: { authorization: "Bearer correct-token-value" },
      }),
    );
    expect(localStill.ok).toBe(true);

    process.env.HEIMDALL_MCP_ALLOWED_HOSTS = "";
    const anyHost = authorizeMcpRequest(
      new Request("http://evil.example/mcp", {
        headers: { authorization: "Bearer correct-token-value" },
      }),
    );
    expect(anyHost.ok).toBe(true);
  });
});
