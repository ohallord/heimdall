import { extractBearerOrHeaderToken } from "@/lib/integrations/tokens";
import {
  findActiveToken,
  hashToken,
  ensureBootstrapOrg,
} from "@/lib/db/store";
import { matchesBootstrapToken } from "@/lib/agents/bootstrap";
import { getDb } from "@/lib/db/client";
import { rememberValidToken } from "@/lib/http-guard/ingest";
import type { AgentRow } from "@/lib/db/types";

export type AgentIngestAuth =
  | { ok: true; orgId: string; agent: AgentRow }
  | { ok: false; error: string; status: number };

const SECRET_PREFIX = "hda_";

/** Legacy shared tokens (org enrollment/bootstrap) stay valid unless HEIMDALL_LEGACY_TOKENS=off. */
function legacyTokensAllowed(): boolean {
  return process.env.HEIMDALL_LEGACY_TOKENS?.trim().toLowerCase() !== "off";
}

/**
 * Authorize post-register agent APIs (heartbeat/metrics/logs/vulns).
 * 1. `hda_` per-agent secret: must belong to the agent named in the body (else 404), not revoked.
 * 2. Legacy org/bootstrap token (grace period): only for agents with no per-agent secret yet,
 *    binds agentId to the token's org; warns once/day.
 */
export async function authorizeAgentIngest(
  request: Request,
  agentId: string,
): Promise<AgentIngestAuth> {
  const id = agentId?.trim();
  if (!id) {
    return { ok: false, error: "agentId is required", status: 400 };
  }

  const token = extractBearerOrHeaderToken(request);
  if (!token) {
    return { ok: false, error: "missing agent token", status: 401 };
  }

  const db = await getDb();

  if (token.startsWith(SECRET_PREFIX)) {
    const owner = (
      await db.query<AgentRow>(`SELECT * FROM agents WHERE secret_hash = $1 LIMIT 1`, [hashToken(token)])
    ).rows[0];
    if (!owner) return { ok: false, error: "invalid agent token", status: 401 };
    if (owner.revoked_at) return { ok: false, error: "agent revoked", status: 401 };
    if (owner.id !== id) return { ok: false, error: "agent not found", status: 404 };
    rememberValidToken(token);
    return { ok: true, orgId: owner.org_id, agent: owner };
  }

  if (!legacyTokensAllowed()) {
    return { ok: false, error: "invalid agent token", status: 401 };
  }
  const orgId = await resolveTokenOrgId(token);
  if (!orgId) {
    return { ok: false, error: "invalid agent token", status: 401 };
  }

  const agent = (
    await db.query<AgentRow>(`SELECT * FROM agents WHERE id = $1 LIMIT 1`, [id])
  ).rows[0];
  if (!agent || agent.org_id !== orgId) {
    // 404 for missing or cross-org — avoid confirming foreign agent ids.
    return { ok: false, error: "agent not found", status: 404 };
  }
  if (agent.revoked_at) return { ok: false, error: "agent revoked", status: 401 };
  // An agent that holds a per-agent secret must use it. Otherwise any host with the shared
  // enrollment/bootstrap token could post metrics, logs or findings as this agent.
  if (agent.secret_hash) {
    return { ok: false, error: "agent has a per-agent secret; shared token refused", status: 401 };
  }

  // Deprecation warning, at most once per agent per day.
  const warned = await db.query(
    `UPDATE agents SET legacy_warned_at = NOW()
     WHERE id = $1 AND (legacy_warned_at IS NULL OR legacy_warned_at < NOW() - INTERVAL '1 day')
     RETURNING id`,
    [agent.id],
  );
  if (warned.rows.length > 0) {
    console.warn(
      `[heimdall] legacy_token: agent ${agent.id} (${agent.hostname}) authenticated with a shared token; re-register to receive a per-agent secret`,
    );
  }

  rememberValidToken(token);
  return { ok: true, orgId, agent };
}

async function resolveTokenOrgId(token: string): Promise<string | null> {
  const tokenRow = await findActiveToken(token);
  if (tokenRow) {
    // A spent single/limited-use enrollment token must not keep authenticating ingest.
    if (tokenRow.max_uses != null && Number(tokenRow.use_count ?? 0) >= Number(tokenRow.max_uses)) {
      return null;
    }
    return tokenRow.org_id;
  }

  if (await matchesBootstrapToken(token)) {
    return (await ensureBootstrapOrg()).id;
  }
  return null;
}
