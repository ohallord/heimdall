import { randomBytes } from "node:crypto";
import { customAlphabet } from "nanoid";

const nano = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 16);

export function newId(prefix: string): string {
  return `${prefix}_${nano()}`;
}

export function newAgentToken(): string {
  return `hdt_${customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 40)()}`;
}

/** UniFi Alarm Manager webhook shared secret. */
export function newUnifiWebhookToken(): string {
  return `hdu_${customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 40)()}`;
}

/** OTLP metrics ingest shared secret. */
export function newOtelIngestToken(): string {
  return `hdo_${customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 40)()}`;
}

/** Runtime / Falco sidekick webhook shared secret. */
export function newRuntimeWebhookToken(): string {
  return `hdr_${customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 40)()}`;
}

/** Per-agent ingest secret (`hda_` + 32 random bytes, base64url). Returned once; only its hash is stored. */
export function newAgentSecret(): string {
  return `hda_${randomBytes(32).toString("base64url")}`;
}

/** Hub-wide bootstrap token minted from Settings → Agents (`hdb_` + 32 random bytes, base64url). */
export function newBootstrapToken(): string {
  return `hdb_${randomBytes(32).toString("base64url")}`;
}
