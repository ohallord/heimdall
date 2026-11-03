import { beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "@/lib/db/client";
import {
  createOrgAndAdmin,
  upsertAlertChannel,
} from "@/lib/db/store";
import { ensureClusterRecord, setActiveCluster } from "@/lib/clusters/store";
import { upsertOidcProvider } from "@/lib/oidc/store";
import { upsertSecurityConnection } from "@/lib/security/store";
import { buildOrgBackup } from "./export";
import { restoreOrgBackup } from "./restore";

describe("backup export/restore", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    delete process.env.DATABASE_URL;
    resetDbForTests();
  });

  it("exports redacted secrets by default and restores remotes/clusters", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "Backup Org",
      adminName: "Admin",
      email: "backup@example.com",
      password: "CorrectHorse1",
    });

    await ensureClusterRecord({
      orgId: org.id,
      clusterId: "default",
      name: "Default",
    });
    await ensureClusterRecord({
      orgId: org.id,
      clusterId: "dr",
      name: "DR",
    });
    await setActiveCluster(org.id, "dr");

    await upsertAlertChannel({
      orgId: org.id,
      kind: "slack",
      enabled: true,
      config: { webhookUrl: "https://hooks.slack.test/secret" },
    });

    await upsertSecurityConnection({
      orgId: org.id,
      kind: "github",
      name: "acme",
      tokenHint: "ghs_…test",
      config: { token: "ghs_supersecret", org: "acme" },
    });

    await upsertOidcProvider({
      orgId: org.id,
      name: "keycloak",
      issuer: "https://idp.test/realms/heimdall",
      clientId: "heimdall",
      clientSecret: "oidc-secret",
    });

    const redacted = await buildOrgBackup({ orgId: org.id });
    expect(redacted.version).toBe(1);
    expect(redacted.settings.activeClusterId).toBe("dr");
    expect(redacted.clusters).toHaveLength(2);
    expect(redacted.remotes[0]?.config.token).toBe("[redacted]");
    expect(redacted.oidcProviders[0]?.clientSecret).toBeUndefined();

    const withSecrets = await buildOrgBackup({
      orgId: org.id,
      includeSecrets: true,
    });
    expect(withSecrets.oidcProviders[0]?.clientSecret).toBe("oidc-secret");
    expect(withSecrets.remotes[0]?.config.token).toBe("ghs_supersecret");

    // Fresh org restore path: create second org and restore from secretful backup.
    const { org: org2 } = await createOrgAndAdmin({
      orgName: "Restore Org",
      adminName: "Admin2",
      email: "restore@example.com",
      password: "CorrectHorse1",
    });

    const result = await restoreOrgBackup({
      orgId: org2.id,
      backup: withSecrets,
    });
    expect(result.clusters).toBe(2);
    expect(result.remotes).toBe(1);
    expect(result.oidcProviders).toBe(1);
    expect(result.channels).toBeGreaterThanOrEqual(1);
  });
});
