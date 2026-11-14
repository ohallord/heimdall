import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbForTests } from "@/lib/db/client";
import { createOrgAndAdmin } from "@/lib/db/store";
import type { NormalizedFinding } from "./types";

const remote = vi.hoisted(() => ({
  github: { findings: [] as NormalizedFinding[], warnings: [] as string[], fail: false },
  gitlab: { findings: [] as NormalizedFinding[], warnings: [] as string[] },
}));

vi.mock("./github", () => ({
  syncGitHubAccount: vi.fn(async () => {
    if (remote.github.fail) throw new Error("github dependabot 500: boom");
    return { findings: remote.github.findings, warnings: remote.github.warnings };
  }),
}));
vi.mock("./gitlab", () => ({
  syncGitLabPath: vi.fn(async () => ({
    findings: remote.gitlab.findings,
    warnings: remote.gitlab.warnings,
  })),
}));

import { listFindings, upsertFindings, upsertSecurityConnection } from "./store";
import { ingestSecurityScan } from "./sync";

const finding = (source: "github" | "gitlab", id: string): NormalizedFinding => ({
  source,
  externalId: id,
  title: id,
  severity: "high",
  resource: `acme/app/${id}`,
  raw: {},
});

async function setup() {
  const { org } = await createOrgAndAdmin({
    orgName: "Sync Org",
    adminName: "Admin",
    email: "sync@example.com",
    password: "CorrectHorse1",
  });
  await upsertSecurityConnection({
    orgId: org.id,
    kind: "github",
    name: "acme",
    config: { token: "ghs_test" },
  });
  await upsertSecurityConnection({
    orgId: org.id,
    kind: "gitlab",
    name: "acme/app",
    config: { token: "glpat_test" },
  });
  return org.id;
}

// Bug: a remote sync that returned 0 alerts left the closed GitHub/GitLab
// findings open on Dashboard → Security.
describe("ingestSecurityScan remote reconciliation", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    delete process.env.DATABASE_URL;
    resetDbForTests();
    remote.github = { findings: [], warnings: [], fail: false };
    remote.gitlab = { findings: [], warnings: [] };
  });

  it("resolves remote findings that are no longer open upstream", async () => {
    const orgId = await setup();
    await upsertFindings(orgId, [
      finding("github", "GHSA-1"),
      finding("github", "GHSA-2"),
      finding("gitlab", "GL-1"),
      { ...finding("github", "CVE-local"), source: "trivy" },
    ]);
    remote.github.findings = [finding("github", "GHSA-2")];

    const r = await ingestSecurityScan({ orgId, syncRemotes: true });
    expect(r.errors).toEqual([]);

    const open = await listFindings(orgId);
    expect(open.map((f) => f.external_id).sort()).toEqual(["CVE-local", "GHSA-2"]);
  });

  it("keeps findings of a kind whose sync failed or warned", async () => {
    const orgId = await setup();
    await upsertFindings(orgId, [finding("github", "GHSA-1"), finding("gitlab", "GL-1")]);
    remote.github.fail = true;
    remote.gitlab.warnings = ["gitlab acme/app: 403"];

    const r = await ingestSecurityScan({ orgId, syncRemotes: true });
    expect(r.errors).toHaveLength(2);

    const open = await listFindings(orgId);
    expect(open.map((f) => f.external_id).sort()).toEqual(["GHSA-1", "GL-1"]);
  });

  it("does not touch remote findings when remotes are not synced", async () => {
    const orgId = await setup();
    await upsertFindings(orgId, [finding("github", "GHSA-1")]);
    await ingestSecurityScan({ orgId, trivyReport: { Results: [] } });
    expect(await listFindings(orgId)).toHaveLength(1);
  });
});
