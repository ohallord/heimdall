import { createHash } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { safeEqual } from "@/lib/http-guard/compare";
import { newBootstrapToken } from "@/lib/ids";

/**
 * Phase 32: the hub-wide bootstrap (register) token.
 *
 * Modes (single row in hub_bootstrap; no row = env):
 * - env:      HEIMDALL_BOOTSTRAP_TOKEN (or the dev default with HEIMDALL_DEV=1 outside production)
 * - rotated:  only the token minted from Settings → Agents; the env value is ignored
 * - disabled: no bootstrap token at all; new hosts need enrollment tokens
 *
 * Registered agents authenticate with their own per-agent secret, so changing the mode
 * never affects them.
 */

export const DEV_BOOTSTRAP_TOKEN = "CHANGE_ME_BOOTSTRAP_TOKEN";
const MIN_STRONG_LENGTH = 24;
const CACHE_MS = 5_000;

export type BootstrapMode = "env" | "rotated" | "disabled";

/** Env value only (kept for callers/tests that predate Phase 32). */
export function resolveBootstrapToken(): string | null {
  const fromEnv = process.env.HEIMDALL_BOOTSTRAP_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (process.env.NODE_ENV !== "production" && process.env.HEIMDALL_DEV === "1") {
    return DEV_BOOTSTRAP_TOKEN;
  }
  return null;
}

type Row = {
  mode: BootstrapMode;
  token_hash: string | null;
  token_hint: string | null;
  updated_at: string | Date | null;
};

let cache: { at: number; row: Row } | null = null;

export function resetBootstrapCache(): void {
  cache = null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hintOf(token: string): string {
  return token.length <= 10 ? "…" : `${token.slice(0, 6)}…${token.slice(-4)}`;
}

async function loadRow(): Promise<Row> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.row;
  const db = await getDb();
  const res = await db.query<Row>(
    `SELECT mode, token_hash, token_hint, updated_at FROM hub_bootstrap WHERE id = 'singleton'`,
  );
  const row: Row = res.rows[0] ?? { mode: "env", token_hash: null, token_hint: null, updated_at: null };
  cache = { at: Date.now(), row };
  return row;
}

/** True when `token` is the currently accepted bootstrap token. */
export async function matchesBootstrapToken(token: string): Promise<boolean> {
  if (!token) return false;
  const row = await loadRow();
  if (row.mode === "disabled") return false;
  if (row.mode === "rotated") {
    return Boolean(row.token_hash) && safeEqual(sha256(token), row.token_hash!);
  }
  const env = resolveBootstrapToken();
  return Boolean(env) && safeEqual(token, env!);
}

export type BootstrapStatus = {
  mode: BootstrapMode;
  /** Where the accepted token comes from. */
  source: "env" | "database" | "none";
  /** False when no bootstrap token is accepted (disabled, or env unset). */
  active: boolean;
  /** The dev default or a short env token is in use. */
  weak: boolean;
  hint: string | null;
  updatedAt: string | null;
};

export async function bootstrapStatus(): Promise<BootstrapStatus> {
  const row = await loadRow();
  const updatedAt = row.updated_at ? new Date(row.updated_at).toISOString() : null;
  if (row.mode === "disabled") {
    return { mode: "disabled", source: "none", active: false, weak: false, hint: null, updatedAt };
  }
  if (row.mode === "rotated") {
    return { mode: "rotated", source: "database", active: true, weak: false, hint: row.token_hint, updatedAt };
  }
  const env = resolveBootstrapToken();
  return {
    mode: "env",
    source: env ? "env" : "none",
    active: Boolean(env),
    weak: Boolean(env) && (env === DEV_BOOTSTRAP_TOKEN || env!.length < MIN_STRONG_LENGTH),
    hint: env ? hintOf(env) : null,
    updatedAt,
  };
}

async function writeRow(
  mode: BootstrapMode,
  userId: string | null,
  token?: string,
): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO hub_bootstrap (id, mode, token_hash, token_hint, updated_by, updated_at)
     VALUES ('singleton', $1, $2, $3, $4, NOW())
     ON CONFLICT (id) DO UPDATE SET mode = EXCLUDED.mode, token_hash = EXCLUDED.token_hash,
       token_hint = EXCLUDED.token_hint, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [mode, token ? sha256(token) : null, token ? hintOf(token) : null, userId],
  );
  resetBootstrapCache();
}

/** Mint a new bootstrap token (returned once; only its hash is stored). */
export async function rotateBootstrapToken(userId: string | null): Promise<{ token: string }> {
  const token = newBootstrapToken();
  await writeRow("rotated", userId, token);
  return { token };
}

export async function disableBootstrapToken(userId: string | null): Promise<void> {
  await writeRow("disabled", userId);
}

export async function revertBootstrapToEnv(userId: string | null): Promise<void> {
  await writeRow("env", userId);
}
