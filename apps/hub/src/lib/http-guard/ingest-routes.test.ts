import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agents/ingest-auth", () => ({
  authorizeAgentIngest: async () => ({ ok: false, status: 401, error: "unauthorized" }),
}));
vi.mock("@/lib/agents", () => ({
  registerAgent: async () => ({ ok: false, status: 401, error: "unauthorized" }),
  heartbeatAgent: async () => ({ ok: false, status: 401, error: "unauthorized" }),
}));
const found = vi.hoisted(() => ({ value: null as null | { orgId: string } }));
vi.mock("@/lib/integrations/tokens", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/tokens")>()),
  findOrgByIntegrationToken: async () => found.value,
}));

import { resetRateLimits } from "./rate-limit";
import { POST as metrics } from "@/app/api/v1/agents/metrics/route";
import { POST as vulns } from "@/app/api/v1/agents/vulns/route";
import { POST as heartbeat } from "@/app/api/v1/agents/heartbeat/route";
import { POST as logs } from "@/app/api/v1/agents/logs/route";
import { POST as register } from "@/app/api/v1/agents/register/route";
import { POST as otlpMetrics } from "@/app/v1/metrics/route";
import { POST as otlpLogs } from "@/app/v1/logs/route";
import { POST as otlpTraces } from "@/app/v1/traces/route";
import { POST as unifi } from "@/app/api/v1/integrations/unifi/webhook/route";
import { POST as runtime } from "@/app/api/v1/integrations/runtime/webhook/route";

type Handler = (r: Request) => Promise<Response>;
const routes: Array<[string, Handler, "INGEST" | "REGISTER" | "WEBHOOK"]> = [
  ["agents/metrics", metrics, "INGEST"],
  ["agents/vulns", vulns, "INGEST"],
  ["agents/heartbeat", heartbeat, "INGEST"],
  ["agents/logs", logs, "INGEST"],
  ["agents/register", register, "REGISTER"],
  ["v1/metrics", otlpMetrics, "INGEST"],
  ["v1/logs", otlpLogs, "INGEST"],
  ["v1/traces", otlpTraces, "INGEST"],
  ["unifi webhook", unifi, "WEBHOOK"],
  ["runtime webhook", runtime, "WEBHOOK"],
];

const req = (body: string) =>
  new Request("http://hub.test/x", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer tok-1" },
    body,
  });

describe.each(routes)("%s guard", (_n, handler, preset) => {
  beforeEach(() => {
    resetRateLimits();
    found.value = { orgId: "org1" };
    delete process.env.HEIMDALL_RATE_INGEST;
    delete process.env.HEIMDALL_RATE_REGISTER;
    delete process.env.HEIMDALL_RATE_WEBHOOK;
    delete process.env.HEIMDALL_MAX_BODY_INGEST;
    delete process.env.HEIMDALL_MAX_BODY_REGISTER;
    delete process.env.HEIMDALL_MAX_BODY_WEBHOOK;
  });

  it("429s with Retry-After once the rate limit is exceeded", async () => {
    process.env[`HEIMDALL_RATE_${preset}`] = "2/60";
    found.value = null;
    expect((await handler(req("{}"))).status).not.toBe(429);
    expect((await handler(req("{}"))).status).not.toBe(429);
    const res = await handler(req("{}"));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("413s when the body exceeds the cap", async () => {
    process.env[`HEIMDALL_MAX_BODY_${preset}`] = "64";
    const res = await handler(req(JSON.stringify({ pad: "x".repeat(200) })));
    expect(res.status).toBe(413);
  });
});
