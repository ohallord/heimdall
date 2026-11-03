import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDbForTests } from "./client";
import {
  createOrgAndAdmin,
  findUserById,
  listAlertChannels,
  promoteTotpPending,
  setUserTotpPending,
  setUserTotpSecret,
  upsertAlertChannel,
} from "./store";
import { getOidcProvider, upsertOidcProvider } from "@/lib/oidc/store";
import { listSecurityConnections, upsertSecurityConnection } from "@/lib/security/store";
import { migrateSecrets } from "./secrets";
import { encryptSecret } from "@/lib/http-guard/crypto-box";

let orgId: string;
let userId: string;

async function raw<T = Record<string, string>>(sql: string, params: unknown[] = []) {
  return (await (await getDb()).query<T>(sql, params)).rows;
}

describe("secrets at rest", () => {
  beforeEach(async () => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    delete process.env.DATABASE_URL;
    resetDbForTests();
    const { org, user } = await createOrgAndAdmin({
      orgName: "Org", adminName: "A", email: "a@example.com", password: "CorrectHorse1",
    });
    orgId = org.id;
    userId = user.id;
  });

  it("TOTP secret and pending are ciphertext in the DB and plaintext through the store", async () => {
    await setUserTotpSecret(userId, "JBSWY3DPEHPK3PXP");
    await setUserTotpPending(userId, "PENDINGSECRET234");
    const [row] = await raw(`SELECT totp_secret, totp_pending FROM users WHERE id=$1`, [userId]);
    expect(row.totp_secret).toMatch(/^enc:v1:/);
    expect(row.totp_pending).toMatch(/^enc:v1:/);
    expect(row.totp_secret).not.toContain("JBSWY3DPEHPK3PXP");
    const u = await findUserById(userId);
    expect(u?.totp_secret).toBe("JBSWY3DPEHPK3PXP");
    expect(u?.totp_pending).toBe("PENDINGSECRET234");

    expect(await promoteTotpPending(userId)).toBe(true);
    const after = await findUserById(userId);
    expect(after?.totp_secret).toBe("PENDINGSECRET234");
    expect(after?.totp_pending).toBeNull();
    expect((await raw(`SELECT totp_secret FROM users WHERE id=$1`, [userId]))[0].totp_secret).toMatch(/^enc:v1:/);
  });

  it("OIDC client_secret is sealed", async () => {
    const p = await upsertOidcProvider({
      orgId, name: "idp", issuer: "https://idp.example", clientId: "cid", clientSecret: "s3cret-value",
    });
    expect(p.client_secret).toBe("s3cret-value");
    const [row] = await raw(`SELECT client_secret FROM oidc_providers WHERE id=$1`, [p.id]);
    expect(row.client_secret).toMatch(/^enc:v1:/);
    expect(row.client_secret).not.toContain("s3cret-value");
    expect((await getOidcProvider(p.id))?.client_secret).toBe("s3cret-value");
    // update path seals too
    await upsertOidcProvider({ orgId, name: "idp", issuer: "https://idp.example", clientId: "cid", clientSecret: "rotated" });
    expect((await raw(`SELECT client_secret FROM oidc_providers WHERE id=$1`, [p.id]))[0].client_secret).toMatch(/^enc:v1:/);
    expect((await getOidcProvider(p.id))?.client_secret).toBe("rotated");
  });

  it("alert channel and security connection config_json are sealed", async () => {
    await upsertAlertChannel({ orgId, kind: "slack", config: { webhookUrl: "https://hooks.example/XYZ-secret" } });
    const [c] = await raw(`SELECT config_json FROM alert_channels WHERE org_id=$1`, [orgId]);
    expect(c.config_json).toMatch(/^enc:v1:/);
    expect(c.config_json).not.toContain("XYZ-secret");
    expect(JSON.parse((await listAlertChannels(orgId))[0].config_json)).toEqual({ webhookUrl: "https://hooks.example/XYZ-secret" });

    await upsertSecurityConnection({ orgId, kind: "github", name: "gh", config: { token: "ghp_supersecret" } });
    const [s] = await raw(`SELECT config_json FROM security_connections WHERE org_id=$1`, [orgId]);
    expect(s.config_json).toMatch(/^enc:v1:/);
    expect(s.config_json).not.toContain("ghp_supersecret");
    expect(JSON.parse((await listSecurityConnections(orgId))[0].config_json)).toEqual({ token: "ghp_supersecret" });
  });

  it("tamper fails closed: no plaintext fallback, error logged", async () => {
    await setUserTotpSecret(userId, "JBSWY3DPEHPK3PXP");
    const [row] = await raw(`SELECT totp_secret FROM users WHERE id=$1`, [userId]);
    const parts = row.totp_secret.split(":");
    parts[3] = Buffer.from("tampered-ciphertext").toString("base64");
    await raw(`UPDATE users SET totp_secret=$1 WHERE id=$2`, [parts.join(":"), userId]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await findUserById(userId))?.totp_secret).toBeNull();
    expect(err).toHaveBeenCalled();

    await upsertAlertChannel({ orgId, kind: "slack", config: { webhookUrl: "x" } });
    await raw(`UPDATE alert_channels SET config_json=$1`, [encryptSecret("{}").replace(/.$/, "A")]);
    expect((await listAlertChannels(orgId))[0].config_json).toBe("{}");
    err.mockRestore();
  });

  it("migrateSecrets re-writes legacy plaintext as ciphertext, idempotently", async () => {
    await raw(`UPDATE users SET totp_secret='LEGACYPLAIN', totp_pending='LEGACYPEND' WHERE id=$1`, [userId]);
    await raw(`INSERT INTO oidc_providers (id, org_id, name, issuer, client_id, client_secret) VALUES ('o1',$1,'n','https://i','c','plain-cs')`, [orgId]);
    await raw(`INSERT INTO alert_channels (id, org_id, kind, config_json) VALUES ('c1',$1,'smtp','{"host":"h","pass":"pw"}')`, [orgId]);
    await raw(`INSERT INTO security_connections (id, org_id, kind, name, config_json) VALUES ('s1',$1,'github','n','{"token":"t"}')`, [orgId]);

    // Legacy plaintext is still readable before migration.
    expect((await findUserById(userId))?.totp_secret).toBe("LEGACYPLAIN");
    expect((await getOidcProvider("o1"))?.client_secret).toBe("plain-cs");

    const db = await getDb();
    expect((await migrateSecrets(db)).migrated).toBe(4);
    expect((await raw(`SELECT totp_secret, totp_pending FROM users WHERE id=$1`, [userId]))[0]).toMatchObject({
      totp_secret: expect.stringMatching(/^enc:v1:/),
      totp_pending: expect.stringMatching(/^enc:v1:/),
    });
    expect((await raw(`SELECT client_secret FROM oidc_providers WHERE id='o1'`))[0].client_secret).toMatch(/^enc:v1:/);
    expect((await raw(`SELECT config_json FROM alert_channels WHERE id='c1'`))[0].config_json).toMatch(/^enc:v1:/);
    expect((await raw(`SELECT config_json FROM security_connections WHERE id='s1'`))[0].config_json).toMatch(/^enc:v1:/);
    expect((await findUserById(userId))?.totp_secret).toBe("LEGACYPLAIN");
    expect((await migrateSecrets(db)).migrated).toBe(0);
  });
});

describe("missing key", () => {
  it("production/Postgres refuses to start without HEIMDALL_SECRET_KEY, with an actionable message", async () => {
    const { resetKeyCache } = await import("@/lib/http-guard/crypto-box");
    const prev = process.env.HEIMDALL_SECRET_KEY;
    delete process.env.HEIMDALL_SECRET_KEY;
    process.env.DATABASE_URL = "postgres://x";
    resetKeyCache();
    try {
      await expect(migrateSecrets({ query: async () => ({ rows: [] }) })).rejects.toThrow(/HEIMDALL_SECRET_KEY is required/);
    } finally {
      process.env.HEIMDALL_SECRET_KEY = prev;
      delete process.env.DATABASE_URL;
      resetKeyCache();
    }
  });
});
