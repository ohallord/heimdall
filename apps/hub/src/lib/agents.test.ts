import { beforeEach, describe, expect, it } from "vitest";
import { heartbeatAgent, listAgents, registerAgent } from "./agents";
import { resetDbForTests } from "./db/client";

describe("agent handshake registry (persistent)", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    process.env.HEIMDALL_BOOTSTRAP_TOKEN = "test-token";
    delete process.env.DATABASE_URL;
    resetDbForTests();
  });

  it("registers a new agent with a valid bootstrap token", async () => {
    const result = await registerAgent({
      token: "test-token",
      hostname: "edge-01",
      version: "0.0.1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.hostname).toBe("edge-01");
    expect(result.agent.id).toMatch(/^agt_/);
    expect(await listAgents()).toHaveLength(1);
  });

  it("rejects an invalid token", async () => {
    const result = await registerAgent({
      token: "wrong",
      hostname: "edge-01",
      version: "0.0.1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
  });

  it("re-registers the same hostname and updates lastSeen", async () => {
    const first = await registerAgent({
      token: "test-token",
      hostname: "edge-01",
      version: "0.0.1",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await registerAgent({
      token: "test-token",
      hostname: "edge-01",
      version: "0.0.2",
      agentSecret: first.agentSecret,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.agent.id).toBe(first.agent.id);
    expect(second.agent.version).toBe("0.0.2");
    expect(await listAgents()).toHaveLength(1);
  });

  it("heartbeats a known agent", async () => {
    const registered = await registerAgent({
      token: "test-token",
      hostname: "edge-01",
      version: "0.0.1",
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const beat = await heartbeatAgent(registered.agent.id);
    expect(beat.ok).toBe(true);
    if (!beat.ok) return;
    expect(beat.agent.lastSeenAt >= registered.agent.lastSeenAt).toBe(true);
  });

  it("returns 404 for unknown heartbeat", async () => {
    const beat = await heartbeatAgent("agt_missing");
    expect(beat.ok).toBe(false);
    if (beat.ok) return;
    expect(beat.status).toBe(404);
  });
});
