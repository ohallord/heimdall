import { beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "@/lib/db/client";
import { createOrgAndAdmin, findUserById } from "@/lib/db/store";
import { findOrCreateOidcUser, upsertOidcProvider } from "./store";

describe("OIDC account linking is not an account-takeover path", () => {
  let orgId: string;
  let adminId: string;
  let providerId: string;
  beforeEach(async () => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    delete process.env.DATABASE_URL;
    resetDbForTests();
    const { org, user } = await createOrgAndAdmin({
      orgName: "Ops", adminName: "Admin", email: "admin@example.com", password: "Correct-Horse-Battery-9",
    });
    orgId = org.id;
    adminId = user.id;
    providerId = (await upsertOidcProvider({
      orgId, name: "idp", issuer: "https://idp.test", clientId: "c", clientSecret: "s",
    })).id;
  });

  it("refuses to link an existing admin when the IdP did not verify the email", async () => {
    await expect(
      findOrCreateOidcUser({ orgId, providerId, sub: "attacker", email: "admin@example.com", name: "x" }),
    ).rejects.toMatchObject({ code: "email_not_verified" });
    expect((await findUserById(adminId))?.oidc_sub).toBeNull();
  });

  it("never re-points an account that is already linked to another IdP subject", async () => {
    await findOrCreateOidcUser({ orgId, providerId, sub: "real-admin", email: "admin@example.com", emailVerified: true, name: "a" });
    await expect(
      findOrCreateOidcUser({ orgId, providerId, sub: "attacker", email: "admin@example.com", emailVerified: true, name: "x" }),
    ).rejects.toMatchObject({ code: "account_linked_elsewhere" });
    expect((await findUserById(adminId))?.oidc_sub).toBe("real-admin");
  });
});
