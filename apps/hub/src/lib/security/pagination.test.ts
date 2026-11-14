import { describe, expect, it, vi } from "vitest";
import {
  fetchGitHubDependabotAlerts,
  fetchGitHubOrgAdvisories,
  fetchGitHubOwnerRepos,
  parseNextLink,
  syncGitHubAccount,
  MAX_SCM_PAGES,
} from "./github";
import { fetchGitLabNamespaceProjects, fetchGitLabVulnerabilities, syncGitLabPath } from "./gitlab";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const alert = (n: number) => ({
  number: n,
  state: "open",
  dependency: { package: { name: "lodash" }, manifest_path: "package-lock.json" },
  security_advisory: { ghsa_id: `GHSA-${n}`, summary: "x", severity: "high" },
});

describe("parseNextLink", () => {
  it("extracts rel=next", () => {
    expect(
      parseNextLink('<https://api.github.com/a?page=1>; rel="prev", <https://api.github.com/a?page=3>; rel="next"'),
    ).toBe("https://api.github.com/a?page=3");
    expect(parseNextLink('<https://api.github.com/a?page=1>; rel="prev"')).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });
});

describe("github pagination", () => {
  it("follows Link rel=next for dependabot alerts", async () => {
    const fetchMock = vi.fn(async (u: RequestInfo | URL) => {
      const url = String(u);
      if (url.includes("page=3")) return json([alert(3)]);
      if (url.includes("page=2"))
        return json([alert(2)], 200, { link: '<https://api.github.com/orgs/o/dependabot/alerts?page=3>; rel="next"' });
      return json([alert(1)], 200, { link: '<https://api.github.com/orgs/o/dependabot/alerts?page=2>; rel="next"' });
    });
    const out = (await fetchGitHubDependabotAlerts({
      token: "t",
      org: "o",
      fetchImpl: fetchMock as unknown as typeof fetch,
    })) as Array<{ number: number }>;
    expect(out.map((a) => a.number)).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("follows pages for advisories and owner repos", async () => {
    const adv = vi.fn(async (u: RequestInfo | URL) =>
      String(u).includes("page=2")
        ? json([{ ghsa_id: "B" }])
        : json([{ ghsa_id: "A" }], 200, { link: '<https://api.github.com/orgs/o/security-advisories?page=2>; rel="next"' }),
    );
    const advOut = (await fetchGitHubOrgAdvisories({ token: "t", org: "o", fetchImpl: adv as unknown as typeof fetch })) as unknown[];
    expect(advOut).toHaveLength(2);

    const repos = vi.fn(async (u: RequestInfo | URL) =>
      String(u).includes("page=2")
        ? json([{ full_name: "me/b", owner: { login: "me" } }])
        : json([{ full_name: "me/a", owner: { login: "me" } }], 200, {
            link: '<https://api.github.com/user/repos?affiliation=owner&page=2>; rel="next"',
          }),
    );
    expect(await fetchGitHubOwnerRepos({ token: "t", owner: "me", fetchImpl: repos as unknown as typeof fetch })).toEqual(["me/a", "me/b"]);
  });

  it("does not follow a next link to another host", async () => {
    const fetchMock = vi.fn(async () =>
      json([alert(1)], 200, { link: '<https://evil.example/steal?page=2>; rel="next"' }),
    );
    const out = (await fetchGitHubDependabotAlerts({ token: "t", org: "o", fetchImpl: fetchMock as unknown as typeof fetch })) as unknown[];
    expect(out).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops at the page cap and warns", async () => {
    const fetchMock = vi.fn(async (u: RequestInfo | URL) => {
      const n = Number(new URL(String(u)).searchParams.get("page") ?? "1");
      const next = `https://api.github.com/orgs/o/dependabot/alerts?state=open&page=${n + 1}`;
      return json([alert(n)], 200, { link: `<${next}>; rel="next"` });
    });
    const warnings: string[] = [];
    const out = (await fetchGitHubDependabotAlerts({
      token: "t",
      org: "o",
      fetchImpl: fetchMock as unknown as typeof fetch,
      onWarning: (m) => warnings.push(m),
    })) as unknown[];
    expect(out).toHaveLength(MAX_SCM_PAGES);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_SCM_PAGES);
    expect(warnings[0]).toMatch(/truncated/i);
  });

  it("syncGitHubAccount surfaces the cap warning", async () => {
    const fetchMock = vi.fn(async (u: RequestInfo | URL) => {
      const url = String(u);
      if (url.includes("dependabot/alerts")) {
        const n = Number(new URL(url).searchParams.get("page") ?? "1");
        return json([alert(n)], 200, {
          link: `<https://api.github.com/orgs/o/dependabot/alerts?state=open&page=${n + 1}>; rel="next"`,
        });
      }
      return json([]);
    });
    const r = await syncGitHubAccount({ token: "t", name: "o", fetchImpl: fetchMock as unknown as typeof fetch });
    expect(r.findings).toHaveLength(MAX_SCM_PAGES);
    expect(r.warnings.some((w) => /truncated/i.test(w))).toBe(true);
  });
});

describe("gitlab pagination", () => {
  const vulnPage = (id: string, next: string | null) => ({
    data: {
      project: {
        vulnerabilities: {
          nodes: [{ id, title: id, severity: "HIGH", primaryIdentifier: { externalId: id } }],
          pageInfo: { hasNextPage: next != null, endCursor: next },
        },
      },
    },
  });

  it("follows pageInfo cursors for vulnerabilities", async () => {
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const vars = JSON.parse(String(init?.body)).variables;
      return json(vars.after === "c1" ? vulnPage("B", null) : vulnPage("A", "c1"));
    });
    const payload = (await fetchGitLabVulnerabilities({
      token: "t",
      projectPath: "g/p",
      fetchImpl: fetchMock as unknown as typeof fetch,
    })) as { data: { project: { vulnerabilities: { nodes: unknown[] } } } };
    expect(payload.data.project.vulnerabilities.nodes).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("follows cursors for namespace projects", async () => {
    const page = (path: string, next: string | null) => ({
      data: { namespace: { projects: { nodes: [{ fullPath: path, archived: false }], pageInfo: { hasNextPage: next != null, endCursor: next } } } },
    });
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const vars = JSON.parse(String(init?.body)).variables;
      return json(vars.after === "c1" ? page("g/b", null) : page("g/a", "c1"));
    });
    expect(await fetchGitLabNamespaceProjects({ token: "t", namespace: "g", fetchImpl: fetchMock as unknown as typeof fetch })).toEqual(["g/a", "g/b"]);
  });

  it("caps pages and warns", async () => {
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const vars = JSON.parse(String(init?.body)).variables;
      const n = vars.after ? Number(vars.after) : 0;
      return json(vulnPage(`V${n}`, String(n + 1)));
    });
    const r = await syncGitLabPath({ token: "t", path: "g/p", fetchImpl: fetchMock as unknown as typeof fetch });
    expect(r.findings).toHaveLength(MAX_SCM_PAGES);
    expect(r.warnings.some((w) => /truncated/i.test(w))).toBe(true);
  });
});
