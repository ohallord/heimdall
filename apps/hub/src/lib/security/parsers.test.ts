import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  fetchGitHubDependabotAlerts,
  parseGitHubDependabotAlerts,
  parseGitHubOrgAdvisories,
} from "./github";
import {
  fetchGitLabVulnerabilities,
  parseGitLabVulnerabilities,
} from "./gitlab";
import { parseOsvScannerReport } from "./osv";
import { parseTrivyReport } from "./trivy";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(path.join(__dirname, "fixtures", name), "utf8"),
  );
}

describe("security parsers (sanitized fixtures)", () => {
  it("parses Trivy image JSON", () => {
    const findings = parseTrivyReport(fixture("trivy-image.json"));
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.externalId).sort()).toEqual([
      "CVE-2022-37434",
      "CVE-2023-44487",
    ]);
    expect(findings.find((f) => f.severity === "critical")?.packageName).toBe(
      "zlib1g",
    );
    expect(findings[0]?.source).toBe("trivy");
  });

  it("parses Trivy rootfs vuln + misconfig as host_posture", () => {
    const findings = parseTrivyReport(fixture("trivy-rootfs.json"), {
      source: "host_posture",
      fallbackResource: "host-rootfs",
      agentId: "agt_test",
    });
    expect(findings).toHaveLength(2);
    const vuln = findings.find((f) => f.externalId === "CVE-2024-12345");
    expect(vuln).toMatchObject({
      source: "host_posture",
      severity: "critical",
      packageName: "openssl",
      agentId: "agt_test",
      resource: "debian 12.5",
    });
    const mis = findings.find((f) => f.externalId === "DSV-0001");
    expect(mis).toMatchObject({
      source: "host_posture",
      severity: "high",
      title: "PermitRootLogin should be no",
      resource: "etc/ssh/sshd_config",
      agentId: "agt_test",
    });
  });

  it("parses osv-scanner lockfile JSON", () => {
    const findings = parseOsvScannerReport(fixture("osv-scanner.json"));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      source: "osv",
      externalId: "GHSA-35jh-r3h4-6jhm",
      packageName: "lodash",
      cve: "CVE-2021-23337",
      severity: "high",
      resource: "/app/package-lock.json",
    });
  });

  it("parses GitHub Dependabot alerts and skips fixed", () => {
    const findings = parseGitHubDependabotAlerts(
      fixture("github-dependabot-alerts.json"),
      "acme",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      source: "github",
      externalId: "GHSA-xvch-5gv4-984h",
      packageName: "minimist",
      severity: "critical",
      fixedVersion: "1.2.6",
    });
  });

  it("parses GitHub org security advisories", () => {
    const findings = parseGitHubOrgAdvisories(
      fixture("github-org-advisories.json"),
      "acme",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.externalId).toBe("GHSA-org-example-aaaa");
    expect(findings[0]?.severity).toBe("medium");
  });

  it("parses GitLab GraphQL vulnerability findings", () => {
    const findings = parseGitLabVulnerabilities(
      fixture("gitlab-vulnerabilities.json"),
      "acme/app",
    );
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.cve).sort()).toEqual([
      "CVE-2023-0286",
      "CVE-2024-12345",
    ]);
    expect(findings.find((f) => f.packageName === "pg")?.severity).toBe("high");
  });

  it("fetches GitHub Dependabot with recorded fixture body", async () => {
    const body = fixture("github-dependabot-alerts.json");
    const fetchMock = vi.fn(async () =>
      Response.json(body, { status: 200 }),
    );
    const raw = await fetchGitHubDependabotAlerts({
      token: "ghs_test",
      org: "acme",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock).toHaveBeenCalled();
    expect(parseGitHubDependabotAlerts(raw)).toHaveLength(1);
  });

  it("fetches GitLab GraphQL with recorded fixture body", async () => {
    const body = fixture("gitlab-vulnerabilities.json");
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body));
      expect(parsed.query).toContain("vulnerabilities");
      expect(parsed.variables.fullPath).toBe("acme/app");
      return Response.json(body, { status: 200 });
    });
    const raw = await fetchGitLabVulnerabilities({
      token: "glpat-test",
      projectPath: "acme/app",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(parseGitLabVulnerabilities(raw)).toHaveLength(2);
  });
});
