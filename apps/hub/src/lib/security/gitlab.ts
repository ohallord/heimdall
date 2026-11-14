import { normalizeSeverity, type NormalizedFinding } from "./types";
import { normalizeScmPath, ScmHttpError } from "./scm-path";
import { guardedFetch } from "@/lib/http-guard/safe-fetch";
import { MAX_SCM_PAGES } from "./github";

type GitlabVulnNode = {
  id?: string;
  title?: string;
  severity?: string;
  state?: string;
  webUrl?: string;
  primaryIdentifier?: { externalType?: string; externalId?: string; name?: string };
  location?: {
    dependency?: {
      package?: { name?: string };
      version?: string;
    };
    image?: string;
    file?: string;
  };
};

type GitlabGraphqlResponse = {
  data?: {
    project?: {
      vulnerabilities?: {
        nodes?: GitlabVulnNode[];
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    };
  };
  errors?: Array<{ message?: string }>;
};

export const GITLAB_VULNS_QUERY = `
query ProjectVulnerabilities($fullPath: ID!, $first: Int!, $after: String) {
  project(fullPath: $fullPath) {
    vulnerabilities(first: $first, after: $after, state: [DETECTED, CONFIRMED]) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        severity
        state
        webUrl
        primaryIdentifier { externalType externalId name }
        location {
          ... on VulnerabilityLocationDependencyScanning {
            dependency { package { name } version }
            file
          }
          ... on VulnerabilityLocationContainerScanning {
            image
            dependency { package { name } version }
          }
        }
      }
    }
  }
}
`.trim();

export function parseGitLabVulnerabilities(
  input: unknown,
  projectFallback = "gitlab",
): NormalizedFinding[] {
  const payload = (input ?? {}) as GitlabGraphqlResponse;
  const nodes = payload.data?.project?.vulnerabilities?.nodes ?? [];
  const findings: NormalizedFinding[] = [];
  for (const n of nodes) {
    const gid = (n.id || "").trim();
    const identifier =
      n.primaryIdentifier?.externalId ||
      n.primaryIdentifier?.name ||
      gid;
    if (!identifier && !gid) continue;
    const externalId = identifier || gid;
    const resource =
      n.location?.file ||
      n.location?.image ||
      `${projectFallback}/${n.location?.dependency?.package?.name || "vuln"}`;
    const cve =
      n.primaryIdentifier?.externalType === "cve"
        ? n.primaryIdentifier.externalId
        : externalId.startsWith("CVE-")
          ? externalId
          : undefined;
    findings.push({
      source: "gitlab",
      externalId,
      title: (n.title || externalId).trim(),
      severity: normalizeSeverity(n.severity),
      packageName: n.location?.dependency?.package?.name,
      packageVersion: n.location?.dependency?.version,
      resource,
      cve,
      url: n.webUrl,
      raw: n,
    });
  }
  return findings;
}

export async function fetchGitLabVulnerabilities(input: {
  token: string;
  projectPath: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  first?: number;
  onWarning?: (message: string) => void;
}): Promise<unknown> {
  const base = (input.apiBaseUrl ?? "https://gitlab.com/api/graphql").replace(
    /\/$/,
    "",
  );
  const fullPath = normalizeScmPath("gitlab", input.projectPath);
  const fetchFn = input.fetchImpl ?? guardedFetch;
  let merged: GitlabGraphqlResponse | null = null;
  let after: string | null = null;
  for (let page = 1; ; page++) {
    const res: Response = await fetchFn(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.token}`,
      },
      body: JSON.stringify({
        query: GITLAB_VULNS_QUERY,
        variables: { fullPath, first: input.first ?? 100, after },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`gitlab graphql ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as GitlabGraphqlResponse;
    if (json.errors?.length) {
      throw new Error(json.errors.map((e) => e.message).join("; "));
    }
    if (json.data && json.data.project == null) {
      throw new ScmHttpError(
        `gitlab project not found: ${fullPath} (needs group/project and a read_api token)`,
        404,
      );
    }
    if (!merged) merged = json;
    else if (merged.data?.project?.vulnerabilities) {
      merged.data.project.vulnerabilities.nodes = [
        ...(merged.data.project.vulnerabilities.nodes ?? []),
        ...(json.data?.project?.vulnerabilities?.nodes ?? []),
      ];
    }
    const info = json.data?.project?.vulnerabilities?.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) break;
    if (page >= MAX_SCM_PAGES) {
      input.onWarning?.(
        `gitlab vulnerabilities ${fullPath}: truncated after ${MAX_SCM_PAGES} pages; more results exist`,
      );
      break;
    }
    after = info.endCursor;
  }
  return merged;
}

export const GITLAB_NAMESPACE_PROJECTS_QUERY = `
query NamespaceProjects($fullPath: ID!, $after: String) {
  namespace(fullPath: $fullPath) {
    projects(first: 100, after: $after, includeSubgroups: true) {
      pageInfo { hasNextPage endCursor }
      nodes { fullPath archived }
    }
  }
}
`.trim();

type GitlabOpts = {
  token: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  onWarning?: (message: string) => void;
};

/** Non-archived project paths in a user or group namespace, or null if no such namespace. */
export async function fetchGitLabNamespaceProjects(
  opts: GitlabOpts & { namespace: string },
): Promise<string[] | null> {
  const base = (opts.apiBaseUrl ?? "https://gitlab.com/api/graphql").replace(/\/$/, "");
  const fetchFn = opts.fetchImpl ?? guardedFetch;
  const out: string[] = [];
  let after: string | null = null;
  for (let page = 1; ; page++) {
    const res: Response = await fetchFn(base, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
      body: JSON.stringify({
        query: GITLAB_NAMESPACE_PROJECTS_QUERY,
        variables: { fullPath: opts.namespace, after },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ScmHttpError(`gitlab graphql ${res.status}: ${text.slice(0, 200)}`, res.status);
    }
    const json = (await res.json()) as {
      errors?: Array<{ message?: string }>;
      data?: {
        namespace?: {
          projects?: {
            nodes?: Array<{ fullPath?: string; archived?: boolean }>;
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          };
        } | null;
      };
    };
    if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
    const ns = json.data?.namespace;
    if (!ns) return page === 1 ? null : out;
    for (const p of ns.projects?.nodes ?? []) if (!p.archived && p.fullPath) out.push(p.fullPath);
    const info = ns.projects?.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) break;
    if (page >= MAX_SCM_PAGES) {
      opts.onWarning?.(
        `gitlab projects ${opts.namespace}: truncated after ${MAX_SCM_PAGES} pages; more projects exist`,
      );
      break;
    }
    after = info.endCursor;
  }
  return out;
}

/** Vulnerabilities for a project path, or for every project when the path is a user/group namespace. */
export async function syncGitLabPath(
  opts: GitlabOpts & { path: string },
): Promise<{ findings: NormalizedFinding[]; warnings: string[] }> {
  const path = normalizeScmPath("gitlab", opts.path);
  const warnings: string[] = [];
  opts = { ...opts, onWarning: (m) => warnings.push(m) };
  try {
    const payload = await fetchGitLabVulnerabilities({ ...opts, projectPath: path });
    return { findings: parseGitLabVulnerabilities(payload, path), warnings };
  } catch (err) {
    if (!(err instanceof ScmHttpError && err.status === 404)) throw err;
  }
  const projects = await fetchGitLabNamespaceProjects({ ...opts, namespace: path });
  if (projects == null) {
    return {
      findings: [],
      warnings: [`gitlab project or namespace not found: ${path} (check the path and a read_api token)`],
    };
  }
  const findings: NormalizedFinding[] = [];
  for (const project of projects) {
    try {
      const payload = await fetchGitLabVulnerabilities({ ...opts, projectPath: project });
      for (const f of parseGitLabVulnerabilities(payload, project)) {
        if (!f.resource.startsWith(`${project}/`)) f.resource = `${project}/${f.resource}`;
        findings.push(f);
      }
    } catch (err) {
      warnings.push(`gitlab ${project}: ${err instanceof Error ? err.message : "failed"}`);
    }
  }
  return { findings, warnings };
}
