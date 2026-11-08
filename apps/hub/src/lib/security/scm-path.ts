/**
 * Accept an org (GitHub) or project path (GitLab) typed as a URL, e.g.
 * "https://github.com/acme" -> "acme", "https://gitlab.com/grp/app.git" -> "grp/app".
 */
export function normalizeScmPath(kind: "github" | "gitlab", raw: string): string {
  let s = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[^/\s]+\.[a-z]{2,}\//i.test(s)) {
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^/]*/, "");
  }
  s = s.split(/[?#]/)[0].split("/-/")[0];
  s = s.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  return kind === "github" ? s.split("/")[0] : s;
}

/** An SCM API call that returned a non-2xx status (or GitLab's "no such project", as 404). */
export class ScmHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
