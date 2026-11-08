import {
  deleteAgentPersistent,
  heartbeatAgentPersistent,
  listAgentsPersistent,
  registerAgentPersistent,
} from "@/lib/db/store";

export type AgentRegistration = {
  id: string;
  hostname: string;
  version: string;
  tokenHint: string;
  registeredAt: string;
  lastSeenAt: string;
  orgId?: string;
  revokedAt?: string | null;
  legacy?: boolean;
};

export type RegisterRequest = {
  token: string;
  hostname: string;
  version: string;
  agentSecret?: string;
};

export type RegisterResult =
  | { ok: true; agent: AgentRegistration; agentSecret?: string }
  | { ok: false; error: string; status: number };

function toRegistration(row: {
  id: string;
  hostname: string;
  version: string;
  registered_at: string | Date;
  last_seen_at: string | Date;
  org_id: string;
  revoked_at?: string | Date | null;
  secret_hash?: string | null;
}): AgentRegistration {
  return {
    id: row.id,
    hostname: row.hostname,
    version: row.version,
    tokenHint: "****",
    registeredAt: new Date(row.registered_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    orgId: row.org_id,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    legacy: !row.secret_hash,
  };
}

/** @deprecated no-op kept for Phase 0 unit tests that reset memory */
export function resetAgentsForTests(): void {
  // Persistent store is reset via resetDbForTests() in integration suites.
}

export async function listAgents(orgId?: string): Promise<AgentRegistration[]> {
  const rows = await listAgentsPersistent(orgId);
  return rows.map(toRegistration);
}

export async function registerAgent(
  input: RegisterRequest,
): Promise<RegisterResult> {
  const result = await registerAgentPersistent(input);
  if (!result.ok) return result;
  return { ok: true, agent: toRegistration(result.agent), agentSecret: result.agentSecret };
}

export async function heartbeatAgent(
  agentId: string,
): Promise<
  { ok: true; agent: AgentRegistration } | { ok: false; error: string; status: number }
> {
  const result = await heartbeatAgentPersistent(agentId);
  if (!result.ok) return result;
  return { ok: true, agent: toRegistration(result.agent) };
}

export async function deleteAgent(
  agentId: string,
  orgId: string,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  return deleteAgentPersistent(agentId, orgId);
}
