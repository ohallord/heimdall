import { beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "@/lib/db/client";
import { createOrgAndAdmin, findUserByEmail } from "@/lib/db/store";
import {
  findOrCreateOidcUser,
  listOidcProviders,
  upsertOidcProvider,
} from "./store";

describe("oidc store", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    delete process.env.DATABASE_URL;
    resetDbForTests();
  });

  it("upserts providers and links users by sub or email", async () => {
    const { org, user } = await createOrgAndAdmin({
      orgName: "OIDC Org",
      adminName: "Admin",
      email: "admin@example.com",
      password: "CorrectHorse1",
    });

    const provider = await upsertOidcProvider({
      orgId: org.id,
      name: "keycloak",
      issuer: "https://idp.test/realms/heimdall",
      clientId: "heimdall",
      clientSecret: "secret",
    });
    expect(provider.issuer).toBe("https://idp.test/realms/heimdall");

    const listed = await listOidcProviders(org.id);
    expect(listed).toHaveLength(1);

    // Link existing admin by email
    const linked = await findOrCreateOidcUser({
      orgId: org.id,
      providerId: provider.id,
      sub: "admin-sub",
      email: user.email,
      emailVerified: true,
      name: "Admin",
    });
    expect(linked.id).toBe(user.id);
    expect(linked.oidc_sub).toBe("admin-sub");

    // Create new viewer for unknown email
    const created = await findOrCreateOidcUser({
      orgId: org.id,
      providerId: provider.id,
      sub: "viewer-sub",
      email: "viewer@example.com",
      name: "Viewer",
    });
    expect(created.role).toBe("viewer");
    expect(created.oidc_provider_id).toBe(provider.id);

    const again = await findOrCreateOidcUser({
      orgId: org.id,
      providerId: provider.id,
      sub: "viewer-sub",
      email: "viewer@example.com",
      name: "Viewer",
    });
    expect(again.id).toBe(created.id);

    const byEmail = await findUserByEmail("viewer@example.com");
    expect(byEmail?.oidc_sub).toBe("viewer-sub");
  });
});
