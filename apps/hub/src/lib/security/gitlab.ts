import { normalizeSeverity, type NormalizedFinding } from "./types";
import { normalizeScmPath } from "./scm-path";
import { guardedFetch } from "@/lib/http-guard/safe-fetch";

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
      };
    };
  };
  errors?: Array<{ message?: string }>;
};

export const GITLAB_VULNS_QUERY = `
query ProjectVulnerabilities($fullPath: ID!, $first: Int!) {
  project(fullPath: $fullPath) {
    vulnerabilities(first: $first, state: [DETECTED, CONFIRMED]) {
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
}): Promise<unknown> {
  const base = (input.apiBaseUrl ?? "https://gitlab.com/api/graphql").replace(
    /\/$/,
    "",
  );
  const fullPath = normalizeScmPath("gitlab", input.projectPath);
  const fetchFn = input.fetchImpl ?? guardedFetch;
  const res = await fetchFn(base, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.token}`,
    },
    body: JSON.stringify({
      query: GITLAB_VULNS_QUERY,
      variables: {
        fullPath,
        first: input.first ?? 50,
      },
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
    throw new Error(`gitlab project not found: ${fullPath} (needs group/project and a read_api token)`);
  }
  return json;
}
