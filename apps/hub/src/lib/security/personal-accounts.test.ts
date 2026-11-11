import { describe, expect, it, vi } from "vitest";
import { syncGitHubAccount } from "./github";
import { syncGitLabPath } from "./gitlab";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const alert = (n: number, manifest = "package-lock.json") => ({
  number: n,
  state: "open",
  dependency: { package: { name: "lodash" }, manifest_path: manifest },
  security_advisory: { ghsa_id: "GHSA-aaaa", summary: "proto pollution", severity: "high" },
});

// Bug: remotes "theohs" (GitHub user) and "personal2160" (GitLab user namespace)
// could never sync: /orgs/{user} 404s and a namespace is not a project.
describe("syncGitHubAccount", () => {
  it("falls back to the user's repos when the name is not an org", async () => {
    const fetchMock = vi.fn(async (u: RequestInfo | URL) => {
      const url = String(u);
      if (url.includes("/orgs/theohs/")) return json({ message: "Not Found" }, 404);
      if (url.includes("/user/repos"))
        return json([
          { full_name: "theohs/a", owner: { login: "theohs" }, archived: false },
          { full_name: "theohs/b", owner: { login: "theohs" }, archived: false },
          { full_name: "theohs/old", owner: { login: "theohs" }, archived: true },
          { full_name: "other/x", owner: { login: "other" }, archived: false },
        ]);
      if (url.includes("/repos/theohs/a/dependabot/alerts")) return json([alert(1)]);
      if (url.includes("/repos/theohs/b/dependabot/alerts"))
        return json({ message: "Dependabot alerts are disabled for this repository." }, 403);
      if (url.includes("/code-scanning/alerts")) return json({ message: "no analysis found" }, 404);
      throw new Error(`unexpected ${url}`);
    });
    const r = await syncGitHubAccount({
      token: "t",
      name: "https://github.com/theohs",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(r.warnings).toEqual([]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].resource).toBe("theohs/a/package-lock.json");
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("security-advisories"))).toBe(false);
    expect(urls.some((u) => u.includes("theohs/old"))).toBe(false);
  });

  it("warns when a repo fails for a reason other than Dependabot being off", async () => {
    const fetchMock = vi.fn(async (u: RequestInfo | URL) => {
      const url = String(u);
      if (url.includes("/orgs/")) return json({}, 404);
      if (url.includes("/user/repos"))
        return json([{ full_name: "theohs/a", owner: { login: "theohs" } }]);
      return json({ message: "Resource not accessible by personal access token" }, 403);
    });
    const r = await syncGitHubAccount({
      token: "t",
      name: "theohs",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.every((w) => /theohs\/a.*403/.test(w))).toBe(true);
  });

  it("reads open code scanning alerts from each owned repo", async () => {
    const fetchMock = vi.fn(async (u: RequestInfo | URL) => {
      const url = String(u);
      if (url.includes("/orgs/")) return json({ message: "Not Found" }, 404);
      if (url.includes("/user/repos"))
        return json([{ full_name: "theohs/app", owner: { login: "theohs" } }]);
      if (url.includes("/dependabot/alerts")) return json([]);
      if (url.includes("/code-scanning/alerts"))
        return json([
          {
            number: 4,
            state: "open",
            html_url: "https://github.com/theohs/app/security/code-scanning/4",
            rule: { id: "py/path-injection", description: "Path injection", security_severity_level: "high" },
            most_recent_instance: { location: { path: "api.py", start_line: 10 } },
          },
        ]);
      throw new Error(`unexpected ${url}`);
    });
    const r = await syncGitHubAccount({
      token: "t",
      name: "theohs",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(r.warnings).toEqual([]);
    expect(r.findings).toEqual([
      expect.objectContaining({
        externalId: "code-scanning-4",
        severity: "high",
        resource: "theohs/app/api.py:10",
      }),
    ]);
  });

  it("still uses the org endpoints for an org", async () => {
    const fetchMock = vi.fn(async (u: RequestInfo | URL) =>
      String(u).includes("dependabot") ? json([alert(1)]) : json([]),
    );
    const r = await syncGitHubAccount({
      token: "t",
      name: "acme",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(r.findings).toHaveLength(1);
    expect(fetchMock.mock.calls.map((c) => String(c[0])).every((u) => u.includes("/orgs/acme/"))).toBe(true);
  });
});

describe("syncGitLabPath", () => {
  const vulns = {
    data: {
      project: {
        vulnerabilities: {
          nodes: [{ id: "gid://1", title: "x", severity: "HIGH", primaryIdentifier: { externalId: "CVE-1", externalType: "cve" }, location: { file: "Gemfile.lock" } }],
        },
      },
    },
  };

  it("expands a user namespace into its projects", async () => {
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.query.includes("NamespaceProjects"))
        return json({
          data: {
            namespace: {
              projects: {
                nodes: [
                  { fullPath: "personal2160/app", archived: false },
                  { fullPath: "personal2160/old", archived: true },
                ],
              },
            },
          },
        });
      if (body.variables.fullPath === "personal2160") return json({ data: { project: null } });
      if (body.variables.fullPath === "personal2160/app") return json(vulns);
      throw new Error(`unexpected ${body.variables.fullPath}`);
    });
    const r = await syncGitLabPath({
      token: "t",
      path: "https://gitlab.com/personal2160",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(r.warnings).toEqual([]);
    expect(r.findings.map((f) => f.resource)).toEqual(["personal2160/app/Gemfile.lock"]);
  });

  it("warns when neither a project nor a namespace exists", async () => {
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return json(body.query.includes("NamespaceProjects") ? { data: { namespace: null } } : { data: { project: null } });
    });
    const r = await syncGitLabPath({ token: "t", path: "nope", fetchImpl: fetchMock as unknown as typeof fetch });
    expect(r.findings).toEqual([]);
    expect(r.warnings[0]).toMatch(/not found: nope/);
  });
});
