import { beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "@/lib/db/client";
import { createOrgAndAdmin } from "@/lib/db/store";
import { parseTrivyReport } from "./trivy";
import { parseOsvScannerReport } from "./osv";
import { parseGitHubDependabotAlerts } from "./github";
import { listFindings, upsertFindings, upsertSecurityConnection } from "./store";
import { readFileSync } from "node:fs";
import path from "node:path";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(path.join(__dirname, "fixtures", name), "utf8"),
  );
}

describe("security findings persistence", () => {
  beforeEach(() => {
    process.env.HEIMDALL_DB_DRIVER = "pglite";
    delete process.env.DATABASE_URL;
    resetDbForTests();
  });

  it("upserts mixed-source findings and lists by severity", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "Sec Org",
      adminName: "Admin",
      email: "sec@example.com",
      password: "CorrectHorse1",
    });

    await upsertSecurityConnection({
      orgId: org.id,
      kind: "github",
      name: "acme",
      tokenHint: "ghs_…test",
      config: { token: "ghs_test", org: "acme" },
    });

    const findings = [
      ...parseTrivyReport(fixture("trivy-image.json")),
      ...parseOsvScannerReport(fixture("osv-scanner.json")),
      ...parseGitHubDependabotAlerts(fixture("github-dependabot-alerts.json")),
    ];
    const written = await upsertFindings(org.id, findings);
    expect(written).toBeGreaterThanOrEqual(4);

    const listed = await listFindings(org.id);
    expect(listed[0]?.severity).toMatch(/critical|high/);
    expect(listed.some((f) => f.source === "trivy")).toBe(true);
    expect(listed.some((f) => f.source === "osv")).toBe(true);
    expect(listed.some((f) => f.source === "github")).toBe(true);

    // Idempotent upsert
    const again = await upsertFindings(org.id, findings);
    expect(again).toBe(written);
    const listed2 = await listFindings(org.id);
    expect(listed2).toHaveLength(listed.length);
  });

  it("stores host_posture findings with agent_id and filters by agent", async () => {
    const { org } = await createOrgAndAdmin({
      orgName: "Posture Org",
      adminName: "Admin",
      email: "posture@example.com",
      password: "CorrectHorse1",
    });

    const db = await (await import("@/lib/db/client")).getDb();
    await db.query(
      `INSERT INTO agents (id, org_id, hostname, version)
       VALUES ($1, $2, 'host-a', '0.1'), ($3, $2, 'host-b', '0.1')`,
      ["agt_a", org.id, "agt_b"],
    );

    const postureA = parseTrivyReport(fixture("trivy-rootfs.json"), {
      source: "host_posture",
      agentId: "agt_a",
    });
    const postureB = parseTrivyReport(fixture("trivy-rootfs.json"), {
      source: "host_posture",
      agentId: "agt_b",
    });
    await upsertFindings(org.id, [...postureA, ...postureB]);

    const forA = await listFindings(org.id, {
      source: "host_posture",
      agentId: "agt_a",
    });
    expect(forA).toHaveLength(2);
    expect(forA.every((f) => f.agent_id === "agt_a")).toBe(true);

    const filtered = await listFindings(org.id, { source: "host_posture" });
    expect(filtered).toHaveLength(4);
  });
});
