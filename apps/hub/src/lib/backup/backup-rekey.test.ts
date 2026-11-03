import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDbForTests } from "@/lib/db/client";
import { createOrgAndAdmin, listAlertChannels, upsertAlertChannel } from "@/lib/db/store";
import { getOidcProvider, listOidcProviders, upsertOidcProvider } from "@/lib/oidc/store";
import { listSecurityConnections, upsertSecurityConnection } from "@/lib/security/store";
import { resetKeyCache } from "@/lib/http-guard/crypto-box";
import { buildOrgBackup } from "./export";
import { restoreOrgBackup } from "./restore";

const KEY_A = "11".repeat(32);
const KEY_B = "22".repeat(32);
const original = process.env.HEIMDALL_SECRET_KEY;

function useKey(hex: string) {
  process.env.HEIMDALL_SECRET_KEY = hex;
  resetKeyCache();
}

describe("backup with secrets across different keys", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    delete process.env.DATABASE_URL;
  });
  afterEach(() => {
    process.env.HEIMDALL_SECRET_KEY = original;
    resetKeyCache();
  });

  it("export decrypts; restore on a hub with another key re-encrypts under that key", async () => {
    // Hub A (key A)
    useKey(KEY_A);
    resetDbForTests();
    const a = await createOrgAndAdmin({ orgName: "A", adminName: "A", email: "a@example.com", password: "CorrectHorse1" });
    await upsertAlertChannel({ orgId: a.org.id, kind: "slack", config: { webhookUrl: "https://hooks.example/S3CRET" } });
    await upsertSecurityConnection({ orgId: a.org.id, kind: "github", name: "gh", config: { token: "ghp_tok" } });
    await upsertOidcProvider({ orgId: a.org.id, name: "idp", issuer: "https://idp.example", clientId: "c", clientSecret: "oidc-sec" });
    const backup = await buildOrgBackup({ orgId: a.org.id, includeSecrets: true });
    // Plaintext in the export (that is what makes it portable), never ciphertext.
    expect(JSON.stringify(backup)).not.toContain("enc:v1:");
    expect(backup.oidcProviders[0].clientSecret).toBe("oidc-sec");
    const redacted = await buildOrgBackup({ orgId: a.org.id });
    expect(JSON.stringify(redacted)).not.toContain("oidc-sec");
    expect(JSON.stringify(redacted)).not.toContain("ghp_tok");

    // Hub B (fresh DB, key B)
    useKey(KEY_B);
    resetDbForTests();
    const b = await createOrgAndAdmin({ orgName: "B", adminName: "B", email: "b@example.com", password: "CorrectHorse1" });
    await restoreOrgBackup({ orgId: b.org.id, backup });

    const db = await getDb();
    const raw = async (sql: string) => (await db.query<{ v: string }>(sql)).rows.map((r) => r.v);
    for (const v of [
      ...(await raw(`SELECT client_secret AS v FROM oidc_providers`)),
      ...(await raw(`SELECT config_json AS v FROM alert_channels`)),
      ...(await raw(`SELECT config_json AS v FROM security_connections`)),
    ]) {
      expect(v).toMatch(/^enc:v1:/);
    }
    // Readable with key B...
    expect((await listOidcProviders(b.org.id))[0].client_secret).toBe("oidc-sec");
    expect(JSON.parse((await listAlertChannels(b.org.id))[0].config_json).webhookUrl).toBe("https://hooks.example/S3CRET");
    expect(JSON.parse((await listSecurityConnections(b.org.id))[0].config_json).token).toBe("ghp_tok");

    // ...and fail closed (not plaintext) once the key is wrong.
    useKey(KEY_A);
    const id = (await listOidcProviders(b.org.id).catch(() => []))[0]?.id;
    expect(id === undefined || (await getOidcProvider(id))?.client_secret === "").toBe(true);
  });
});
