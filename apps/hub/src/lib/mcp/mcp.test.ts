import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAgent } from "@/lib/agents";
import { getDb, resetDbForTests } from "@/lib/db/client";
import { createOrgAndAdmin, insertAlertEvent } from "@/lib/db/store";
import { newId } from "@/lib/ids";
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
    delete process.env.HEIMDALL_ORG_ID;
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

  it("reports the org with an admin, and can filter past a newer flood", async () => {
    const { org: ops } = await createOrgAndAdmin({
      orgName: "Heimdall Ops",
      adminName: "Dan",
      email: "dan@example.com",
      password: "CorrectHorse1",
    });
    const db = await getDb();
    const staleId = newId("org");
    await db.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [
      staleId,
      "Bootstrap",
    ]);
    await db.query(
      `UPDATE organizations SET created_at = NOW() - INTERVAL '2 days' WHERE id = $1`,
      [staleId],
    );
    const staleRule = await insertRule(staleId, "K8s API unreachable", "k8s_apiserver_unreachable");
    await insertAlertEvent({
      id: newId("evt"),
      orgId: staleId,
      ruleId: staleRule,
      severity: "warning",
      message: "k8s_apiserver_unreachable gte 1 (observed 1)",
      payload: { hostname: "compose-agent-01" },
    });

    const sshRule = await insertRule(ops.id, "Log: Failed SSH password", "log_match:ssh_failed_password");
    const k8sRule = await insertRule(ops.id, "K8s API unreachable", "k8s_apiserver_unreachable");
    const sshMessage = "Failed password for root from 203.0.113.50 port 22 ssh2";
    const leaked = `${sshMessage} hdt_abcdefghijklmnopqrstuvwxyz`;
    await insertAlertEvent({
      id: newId("evt"),
      orgId: ops.id,
      ruleId: sshRule,
      severity: "warning",
      message: leaked,
      payload: { hostname: "edge-01", source: "sshd.service" },
    });
    for (let i = 0; i < 21; i += 1) {
      await insertAlertEvent({
        id: newId("evt"),
        orgId: ops.id,
        ruleId: k8sRule,
        severity: "warning",
        message: "k8s_apiserver_unreachable gte 1 (observed 1)",
        payload: { hostname: "compose-agent-01" },
      });
    }

    const page = await alertPayload({});
    expect(page.open).toBe(22);
    expect(page.alerts).toHaveLength(20);
    expect(page.alerts.every((alert) => alert.rule === "K8s API unreachable")).toBe(true);
    expect(page.byRule).toEqual([
      { rule: "K8s API unreachable", count: 21 },
      { rule: "Log: Failed SSH password", count: 1 },
    ]);

    const ssh = await alertPayload({ rule: "Failed SSH", host: "edge-01" });
    expect(ssh.alerts).toHaveLength(1);
    expect(ssh.alerts[0]?.host).toBe("edge-01");
    expect(ssh.alerts[0]?.source).toBe("sshd.service");
    expect(ssh.alerts[0]?.message).toContain("203.0.113.50");
    expect(ssh.alerts[0]?.message).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(ssh.alerts[0]?.message).toContain("hdt_[REDACTED]");

    process.env.HEIMDALL_ORG_ID = staleId;
    const pinned = await alertPayload({ rule: "K8s" });
    expect(pinned.open).toBe(1);
    expect(pinned.alerts[0]?.host).toBe("compose-agent-01");
  });
});

async function insertRule(orgId: string, name: string, metric: string): Promise<string> {
  const db = await getDb();
  const id = newId("rul");
  await db.query(
    `INSERT INTO alert_rules (
       id, org_id, name, metric, operator, threshold, enabled
     ) VALUES ($1, $2, $3, $4, 'gte', 1, TRUE)`,
    [id, orgId, name, metric],
  );
  return id;
}

async function alertPayload(args: {
  rule?: string;
  host?: string;
  offset?: number;
}): Promise<{
  open: number;
  byRule: Array<{ rule: string; count: number }>;
  alerts: Array<{
    rule: string;
    host: string | null;
    source: string | null;
    message: string;
  }>;
}> {
  const result = await withClient((client) =>
    client.callTool({ name: "heimdall_alerts", arguments: args }),
  );
  const text = result.content?.find((part) => part.type === "text")?.text ?? "";
  return JSON.parse(text) as {
    open: number;
    byRule: Array<{ rule: string; count: number }>;
    alerts: Array<{
      rule: string;
      host: string | null;
      source: string | null;
      message: string;
    }>;
  };
}
