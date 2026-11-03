import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PREFIX = "enc:v1:";
let cachedKey: Buffer | null = null;

export function resetKeyCache(): void {
  cachedKey = null;
}

function parseKey(raw: string): Buffer | null {
  const s = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) {
    const b = Buffer.from(s, "base64");
    if (b.length === 32) return b;
  }
  return null;
}

const MISSING =
  "HEIMDALL_SECRET_KEY is required (32 bytes, hex or base64). Generate one with: openssl rand -hex 32";

export function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const env = process.env.HEIMDALL_SECRET_KEY?.trim();
  if (env) {
    const k = parseKey(env);
    if (!k) throw new Error("HEIMDALL_SECRET_KEY must be 32 bytes, hex (64 chars) or base64. Generate: openssl rand -hex 32");
    return (cachedKey = k);
  }
  if (process.env.DATABASE_URL?.trim() || process.env.NODE_ENV === "production") {
    throw new Error(MISSING);
  }
  // Home (PGlite) mode: auto-create a key file in the data dir.
  const dir = process.env.HEIMDALL_DATA_DIR?.trim() || "./data";
  const file = join(dir, "secret.key");
  if (existsSync(file)) {
    const k = parseKey(readFileSync(file, "utf8"));
    if (!k) throw new Error(`${file} is not a valid 32-byte key`);
    return (cachedKey = k);
  }
  mkdirSync(dir, { recursive: true });
  const k = randomBytes(32);
  writeFileSync(file, k.toString("hex") + "\n", { mode: 0o600 });
  return (cachedKey = k);
}

export function isEncrypted(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(PREFIX);
}

export function encryptSecret(plain: string): string {
  const key = loadKey();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${ct.toString("base64")}:${tag.toString("base64")}`;
}

/** Throws on tamper, wrong key, or non-encrypted input (fail closed). */
export function decryptSecret(v: string): string {
  if (!isEncrypted(v)) throw new Error("value is not encrypted");
  const [iv, ct, tag] = v.slice(PREFIX.length).split(":");
  if (!iv || !ct || !tag) throw new Error("malformed encrypted value");
  const d = createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}
