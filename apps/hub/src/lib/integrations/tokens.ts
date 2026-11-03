import { getDb } from "@/lib/db/client";
import { hashToken } from "@/lib/db/store";
import type { IntegrationTokenKind, IntegrationTokenRow } from "@/lib/db/types";
import {
  newId,
  newOtelIngestToken,
  newRuntimeWebhookToken,
  newUnifiWebhookToken,
} from "@/lib/ids";

export function tokenHint(token: string): string {
  if (token.length <= 8) return "****";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

export function mintPlainToken(kind: IntegrationTokenKind): string {
  if (kind === "unifi_webhook") return newUnifiWebhookToken();
  if (kind === "runtime_webhook") return newRuntimeWebhookToken();
  return newOtelIngestToken();
}

export function extractBearerOrHeaderToken(request: Request): string | null {
  const headerToken = request.headers.get("x-heimdall-token")?.trim();
  if (headerToken) return headerToken;
  const auth = request.headers.get("authorization");
  if (!auth) return null;
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return match?.[1]?.trim() || null;
}

export async function getIntegrationToken(
  orgId: string,
  kind: IntegrationTokenKind,
): Promise<IntegrationTokenRow | null> {
  const db = await getDb();
  const result = await db.query<IntegrationTokenRow>(
    `SELECT * FROM integration_tokens WHERE org_id = $1 AND kind = $2 LIMIT 1`,
    [orgId, kind],
  );
  return result.rows[0] ?? null;
}

export async function findOrgByIntegrationToken(
  kind: IntegrationTokenKind,
  token: string,
): Promise<{ orgId: string; row: IntegrationTokenRow } | null> {
  const db = await getDb();
  const result = await db.query<IntegrationTokenRow>(
    `SELECT * FROM integration_tokens WHERE kind = $1 AND token_hash = $2 LIMIT 1`,
    [kind, hashToken(token)],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { orgId: row.org_id, row };
}

export async function rotateIntegrationToken(input: {
  orgId: string;
  kind: IntegrationTokenKind;
  /** When set, use this plaintext instead of minting (tests). */
  token?: string;
}): Promise<{ row: IntegrationTokenRow; token: string }> {
  const token = input.token ?? mintPlainToken(input.kind);
  const db = await getDb();
  const id = newId("itk");
  const hint = tokenHint(token);
  const hash = hashToken(token);

  await db.query(
    `INSERT INTO integration_tokens (id, org_id, kind, token_hash, token_hint)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, kind) DO UPDATE SET
       id = EXCLUDED.id,
       token_hash = EXCLUDED.token_hash,
       token_hint = EXCLUDED.token_hint,
       created_at = NOW()`,
    [id, input.orgId, input.kind, hash, hint],
  );

  const row = await getIntegrationToken(input.orgId, input.kind);
  if (!row) throw new Error("failed to persist integration token");
  return { row, token };
}

export async function ensureIntegrationToken(input: {
  orgId: string;
  kind: IntegrationTokenKind;
}): Promise<{ row: IntegrationTokenRow; token: string | null }> {
  const existing = await getIntegrationToken(input.orgId, input.kind);
  if (existing) return { row: existing, token: null };
  const rotated = await rotateIntegrationToken(input);
  return { row: rotated.row, token: rotated.token };
}
