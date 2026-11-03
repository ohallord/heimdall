import { getDb } from "@/lib/db/client";
import type { OidcProviderRow, User } from "@/lib/db/types";
import { hashPassword } from "@/lib/auth/password";
import { newId } from "@/lib/ids";
import { openOidc, openUser, sealText } from "@/lib/db/secrets";

export async function listOidcProviders(
  orgId?: string,
): Promise<OidcProviderRow[]> {
  const db = await getDb();
  if (orgId) {
    const result = await db.query<OidcProviderRow>(
      `SELECT * FROM oidc_providers WHERE org_id = $1 ORDER BY name`,
      [orgId],
    );
    return result.rows.map(openOidc);
  }
  const result = await db.query<OidcProviderRow>(
    `SELECT * FROM oidc_providers WHERE enabled = TRUE ORDER BY created_at ASC`,
  );
  return result.rows.map(openOidc);
}

export async function getOidcProvider(
  id: string,
): Promise<OidcProviderRow | null> {
  const db = await getDb();
  const result = await db.query<OidcProviderRow>(
    `SELECT * FROM oidc_providers WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? openOidc(result.rows[0]) : null;
}

export async function upsertOidcProvider(input: {
  orgId: string;
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes?: string;
  enabled?: boolean;
}): Promise<OidcProviderRow> {
  const db = await getDb();
  const existing = await db.query<OidcProviderRow>(
    `SELECT * FROM oidc_providers WHERE org_id = $1 AND name = $2 LIMIT 1`,
    [input.orgId, input.name],
  );
  if (existing.rows[0]) {
    await db.query(
      `UPDATE oidc_providers SET
        issuer = $1, client_id = $2, client_secret = $3,
        scopes = $4, enabled = $5
       WHERE id = $6`,
      [
        input.issuer.replace(/\/$/, ""),
        input.clientId,
        sealText(input.clientSecret),
        input.scopes ?? "openid profile email",
        input.enabled ?? true,
        existing.rows[0].id,
      ],
    );
    return (await getOidcProvider(existing.rows[0].id))!;
  }
  const id = newId("oidc");
  await db.query(
    `INSERT INTO oidc_providers
      (id, org_id, name, issuer, client_id, client_secret, scopes, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      input.orgId,
      input.name,
      input.issuer.replace(/\/$/, ""),
      input.clientId,
      sealText(input.clientSecret),
      input.scopes ?? "openid profile email",
      input.enabled ?? true,
    ],
  );
  return (await getOidcProvider(id))!;
}

export async function findOrCreateOidcUser(input: {
  orgId: string;
  providerId: string;
  sub: string;
  email: string;
  name: string;
}): Promise<User> {
  const db = await getDb();
  const bySub = await db.query<User>(
    `SELECT * FROM users WHERE oidc_provider_id = $1 AND oidc_sub = $2 LIMIT 1`,
    [input.providerId, input.sub],
  );
  if (bySub.rows[0]) return openUser(bySub.rows[0]);

  const byEmail = await db.query<User>(
    `SELECT * FROM users WHERE org_id = $1 AND email = $2 LIMIT 1`,
    [input.orgId, input.email.toLowerCase()],
  );
  if (byEmail.rows[0]) {
    await db.query(
      `UPDATE users SET oidc_sub = $1, oidc_provider_id = $2 WHERE id = $3`,
      [input.sub, input.providerId, byEmail.rows[0].id],
    );
    return openUser(
      (await db.query<User>(`SELECT * FROM users WHERE id = $1`, [byEmail.rows[0].id])).rows[0],
    );
  }

  const id = newId("usr");
  // Unusable local password — OIDC-only account.
  const passwordHash = await hashPassword(`oidc-only:${newId("pwd")}`);
  await db.query(
    `INSERT INTO users
      (id, org_id, email, name, password_hash, role, mfa_enrolled, oidc_sub, oidc_provider_id)
     VALUES ($1,$2,$3,$4,$5,'viewer', FALSE, $6, $7)`,
    [
      id,
      input.orgId,
      input.email.toLowerCase(),
      input.name || input.email,
      passwordHash,
      input.sub,
      input.providerId,
    ],
  );
  return openUser((await db.query<User>(`SELECT * FROM users WHERE id = $1`, [id])).rows[0]);
}
