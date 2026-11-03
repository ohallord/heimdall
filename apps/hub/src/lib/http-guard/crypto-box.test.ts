import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, isEncrypted, resetKeyCache } from "./crypto-box";

const KEY_HEX = "00".repeat(31) + "01";
const ENV = ["HEIMDALL_SECRET_KEY", "DATABASE_URL", "NODE_ENV", "HEIMDALL_DATA_DIR"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  resetKeyCache();
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetKeyCache();
});

describe("crypto-box", () => {
  it("roundtrips with hex key", () => {
    process.env.HEIMDALL_SECRET_KEY = KEY_HEX;
    const c = encryptSecret("hunter2");
    expect(c.startsWith("enc:v1:")).toBe(true);
    expect(c).not.toContain("hunter2");
    expect(isEncrypted(c)).toBe(true);
    expect(decryptSecret(c)).toBe("hunter2");
  });
  it("accepts base64 key", () => {
    process.env.HEIMDALL_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
    expect(decryptSecret(encryptSecret("x"))).toBe("x");
  });
  it("uses a fresh IV each time", () => {
    process.env.HEIMDALL_SECRET_KEY = KEY_HEX;
    expect(encryptSecret("a")).not.toBe(encryptSecret("a"));
  });
  it("fails closed on tamper", () => {
    process.env.HEIMDALL_SECRET_KEY = KEY_HEX;
    const parts = encryptSecret("secret").split(":");
    const ct = Buffer.from(parts[3], "base64");
    ct[0] ^= 1;
    parts[3] = ct.toString("base64");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });
  it("fails with a different key", () => {
    process.env.HEIMDALL_SECRET_KEY = KEY_HEX;
    const c = encryptSecret("s");
    resetKeyCache();
    process.env.HEIMDALL_SECRET_KEY = "11".repeat(32);
    expect(() => decryptSecret(c)).toThrow();
  });
  it("rejects a malformed key", () => {
    process.env.HEIMDALL_SECRET_KEY = "tooshort";
    expect(() => encryptSecret("x")).toThrow(/HEIMDALL_SECRET_KEY/);
  });
  it("decrypt of non-encrypted value throws; isEncrypted false", () => {
    process.env.HEIMDALL_SECRET_KEY = KEY_HEX;
    expect(isEncrypted("plain")).toBe(false);
    expect(() => decryptSecret("plain")).toThrow();
  });
  it("throws with actionable message when key missing in Postgres mode", () => {
    process.env.DATABASE_URL = "postgres://x";
    expect(() => encryptSecret("x")).toThrow(/HEIMDALL_SECRET_KEY/);
  });
  it("throws when key missing in production", () => {
    process.env.NODE_ENV = "production";
    expect(() => encryptSecret("x")).toThrow(/HEIMDALL_SECRET_KEY/);
  });
  it("auto-creates secret.key (0600) in home mode and reuses it", () => {
    const dir = mkdtempSync(join(tmpdir(), "hd-"));
    process.env.HEIMDALL_DATA_DIR = dir;
    const c = encryptSecret("x");
    const file = join(dir, "secret.key");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const first = readFileSync(file, "utf8");
    resetKeyCache();
    expect(decryptSecret(c)).toBe("x");
    expect(readFileSync(file, "utf8")).toBe(first);
  });
});
