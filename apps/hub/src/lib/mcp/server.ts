import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  guardTool,
  heimdallAgent,
  heimdallAgents,
  heimdallAlerts,
  heimdallFindings,
  heimdallStatus,
} from "./tools";

export const HEIMDALL_MCP_TOOLS = [
  "heimdall_status",
  "heimdall_agents",
  "heimdall_agent",
  "heimdall_alerts",
  "heimdall_findings",
] as const;

const INSTRUCTIONS =
  "These tools only report Heimdall state. There is no write tool. Do not mute, dismiss, enroll, revoke, or change anything.";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** Fresh server per request. Stateless: no session store. */
export function createHeimdallMcpServer(): McpServer {
  const server = new McpServer(
    { name: "heimdall", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "heimdall_status",
    {
      description:
        "Read-only hub status: health-style ok, whether setup is done, agent counts (total, online, revoked), and the open-alert count. Online means last seen within 45 seconds. Does not change state.",
      annotations: READ_ONLY,
    },
    async () => guardTool(() => heimdallStatus()),
  );

  server.registerTool(
    "heimdall_agents",
    {
      description:
        "Read-only list of agents for the primary org (capped). Fields: id, hostname, version, lastSeenAt, online, revokedAt. Online means last seen within 45 seconds. Does not change state.",
      annotations: READ_ONLY,
    },
    async () => guardTool(() => heimdallAgents()),
  );

  server.registerTool(
    "heimdall_agent",
    {
      description:
        "Read-only detail for one agent by id or hostname: latest CPU, memory, and disks, containers, and the Kubernetes snapshot. Does not change state.",
      inputSchema: {
        id: z.string().optional().describe("Agent id"),
        hostname: z.string().optional().describe("Agent hostname"),
      },
      annotations: READ_ONLY,
    },
    async (args) => guardTool(() => heimdallAgent(args)),
  );

  server.registerTool(
    "heimdall_alerts",
    {
      description:
        "Read-only open alert events for the primary org (capped): rule, host, state, and time. There is no mute or dismiss.",
      annotations: READ_ONLY,
    },
    async () => guardTool(() => heimdallAlerts()),
  );

  server.registerTool(
    "heimdall_findings",
    {
      description:
        "Read-only open finding counts by severity plus a short list (id, title, severity, host). Does not change state.",
      annotations: READ_ONLY,
    },
    async () => guardTool(() => heimdallFindings()),
  );

  return server;
}
