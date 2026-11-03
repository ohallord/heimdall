import { decryptSecret, encryptSecret, isEncrypted, loadKey } from "@/lib/http-guard/crypto-box";
import type { AlertChannelRow, OidcProviderRow, SecurityConnectionRow, User } from "./types";

/**
 * Seal/open at the repository boundary. Stores call these on write and on every row they return,
 * so callers only ever see plaintext. Legacy plaintext rows are readable and are re-written
 * encrypted by `migrateSecrets()` at startup.
 *
 * Decrypt failures (wrong key, tamper) fail closed: the secret reads as empty/`{}` and an error is
 * logged, so the feature errors instead of using garbage and the UI can ask for it to be re-entered.
 */

export function sealText(v: string | null | undefined): string | null {
  if (v === null || v === undefined || v === "") return v ?? null;
  return isEncrypted(v) ? v : encryptSecret(v);
}

export function openText(v: string | null | undefined): string | null {
  if (v === null || v === undefined || v === "") return v ?? null;
  if (!isEncrypted(v)) return v; // legacy plaintext
  try {
    return decryptSecret(v);
  } catch (err) {
    console.error("[heimdall] secret decrypt failed (wrong HEIMDALL_SECRET_KEY or tampered value); re-enter it:", (err as Error).message);
    return null;
  }
}

export function sealJson(json: string): string {
  return isEncrypted(json) ? json : encryptSecret(json);
}

export function openJson(v: string): string {
  if (!isEncrypted(v)) return v; // legacy plaintext JSON
  try {
    return decryptSecret(v);
  } catch (err) {
    console.error("[heimdall] config decrypt failed (wrong HEIMDALL_SECRET_KEY or tampered value); re-enter it:", (err as Error).message);
    return "{}";
  }
}

export function openUser<T extends User | null | undefined>(u: T): T {
  if (!u) return u;
  return { ...u, totp_secret: openText(u.totp_secret), totp_pending: openText(u.totp_pending) };
}

export function openOidc(r: OidcProviderRow): OidcProviderRow {
  return { ...r, client_secret: openText(r.client_secret) ?? "" };
}

export function openChannel(r: AlertChannelRow): AlertChannelRow {
  return { ...r, config_json: openJson(r.config_json) };
}

export function openConnection(r: SecurityConnectionRow): SecurityConnectionRow {
  return { ...r, config_json: openJson(r.config_json) };
}

type Q = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }> };

/**
 * Startup pass: require a usable key (throws with an actionable message in production/Postgres),
 * then re-write any legacy plaintext secret as ciphertext. Idempotent; skips `enc:` values.
 */
export async function migrateSecrets(db: Q): Promise<{ migrated: number }> {
  loadKey();
  let migrated = 0;
  const jobs: Array<{ table: string; id: string; cols: string[] }> = [
    { table: "users", id: "id", cols: ["totp_secret", "totp_pending"] },
    { table: "oidc_providers", id: "id", cols: ["client_secret"] },
    { table: "alert_channels", id: "id", cols: ["config_json"] },
    { table: "security_connections", id: "id", cols: ["config_json"] },
  ];
  for (const j of jobs) {
    const where = j.cols.map((c) => `(${c} IS NOT NULL AND ${c} <> '' AND ${c} NOT LIKE 'enc:%')`).join(" OR ");
    const rows = (await db.query<Record<string, string | null>>(`SELECT ${j.id}, ${j.cols.join(", ")} FROM ${j.table} WHERE ${where}`)).rows;
    for (const row of rows) {
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const c of j.cols) {
        const v = row[c];
        if (v && !isEncrypted(v)) {
          params.push(encryptSecret(v));
          sets.push(`${c} = $${params.length}`);
        }
      }
      if (sets.length === 0) continue;
      params.push(row[j.id]);
      await db.query(`UPDATE ${j.table} SET ${sets.join(", ")} WHERE ${j.id} = $${params.length}`, params);
      migrated++;
    }
  }
  return { migrated };
}
