import { describe, expect, it, vi } from "vitest";
import { fetchGitHubDependabotAlerts } from "./github";
import { fetchGitLabVulnerabilities } from "./gitlab";
import { normalizeScmPath } from "./scm-path";

// Bug: the setup wizard stored "https://github.com/theohs" as the org, so sync
// requested /orgs/https%3A%2F%2F…/dependabot/alerts (404) and GitLab silently
// returned no project: "0 findings + 1 warning".
describe("normalizeScmPath", () => {
  it.each([
    ["github", "https://github.com/theohs", "theohs"],
    ["github", "github.com/theohs/", "theohs"],
    ["github", "theohs", "theohs"],
    ["gitlab", "https://gitlab.com/personal2160", "personal2160"],
    ["gitlab", "https://gitlab.com/grp/sub/app.git", "grp/sub/app"],
    ["gitlab", "https://gitlab.example.com/grp/app/-/security", "grp/app"],
    ["gitlab", "grp/app", "grp/app"],
  ] as const)("%s %s -> %s", (kind, raw, want) => {
    expect(normalizeScmPath(kind, raw)).toBe(want);
  });
});

describe("fetchers accept URL-form names", () => {
  it("GitHub requests the bare org", async () => {
    const fetchMock = vi.fn(async () => new Response("[]", { status: 200 }));
    await fetchGitHubDependabotAlerts({
      token: "t",
      org: "https://github.com/theohs",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/orgs/theohs/dependabot");
  });

  it("GitLab sends the bare path and errors when the project is missing", async () => {
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).variables.fullPath).toBe("grp/app");
      return new Response(JSON.stringify({ data: { project: null } }), { status: 200 });
    });
    await expect(
      fetchGitLabVulnerabilities({
        token: "t",
        projectPath: "https://gitlab.com/grp/app",
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/gitlab project not found: grp\/app/);
  });
});
