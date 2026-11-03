import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Files the hub serves for one-command host installs, produced by
 * scripts/build-dist.sh (baked into the image at /app/dist).
 */
export function distDir(): string {
  return process.env.HEIMDALL_DIST_DIR || join(/* turbopackIgnore: true */ process.cwd(), "dist");
}

export const MANIFEST = "SHA256SUMS";
export const INSTALL_SCRIPT = "install-host.sh";
export const DIST_MISSING_HINT =
  "agent downloads are not built into this hub; run scripts/build-dist.sh (the Docker image does this)";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** name → sha256 for every well-formed, path-free entry (plus the manifest itself). */
export async function readManifest(): Promise<Map<string, string> | null> {
  let text: string;
  try {
    text = await readFile(join(/* turbopackIgnore: true */ distDir(), MANIFEST), "utf8");
  } catch {
    return null;
  }
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (m && NAME_RE.test(m[2]) && !m[2].includes("..")) out.set(m[2], m[1]);
  }
  out.set(MANIFEST, "");
  return out;
}

/** Absolute path of an allow-listed dist file, or null. */
export async function resolveDistFile(name: string): Promise<string | null> {
  if (!NAME_RE.test(name) || name.includes("..")) return null;
  const manifest = await readManifest();
  if (!manifest?.has(name)) return null;
  const path = join(/* turbopackIgnore: true */ distDir(), name);
  try {
    const s = await stat(path);
    return s.isFile() ? path : null;
  } catch {
    return null;
  }
}

/** Only plain http(s) origins/paths are baked into a shell script. */
export function safeHubUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const url = raw.trim().replace(/\/+$/, "");
  return /^https?:\/\/[A-Za-z0-9.:\-[\]/_]+$/.test(url) ? url : null;
}

export function hubUrlFor(request: Request): string | null {
  const env = process.env.HEIMDALL_PUBLIC_URL;
  if (env) return safeHubUrl(env);
  const u = new URL(request.url);
  return safeHubUrl(`${u.protocol}//${u.host}`);
}

/** Replace the HUB_URL placeholder; an unsafe/unknown URL leaves it (script then requires HUB_URL). */
export function renderInstallScript(script: string, hubUrl: string | null): string {
  if (!hubUrl) return script;
  return script.replace(
    'HUB_URL="${HUB_URL:-__HEIMDALL_HUB_URL__}"',
    `HUB_URL="\${HUB_URL:-${hubUrl}}"`,
  );
}

/** install-host.sh from dist, or the repo copy in dev. */
export async function readInstallScript(): Promise<string | null> {
  for (const p of [
    join(/* turbopackIgnore: true */ distDir(), INSTALL_SCRIPT),
    join(/* turbopackIgnore: true */ process.cwd(), "..", "..", "scripts", INSTALL_SCRIPT),
  ]) {
    try {
      return await readFile(p, "utf8");
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Copy-ready one-command installs for an enrollment token.
 *
 * The default commands prompt for the token instead of passing it on the sudo
 * command line: `sudo TOKEN=… bash` writes the token into sudo's journal
 * entry, and from there into any log shipper. `agentNonInteractive` keeps the
 * inline form for automation.
 */
export function installCommandsFor(
  request: Request,
  token: string,
): { agent: string; agentWithOtel: string; agentNonInteractive: string } {
  const hub = hubUrlFor(request) ?? "https://<hub>";
  return {
    agent: `curl -fsSL ${hub}/install.sh | sudo bash`,
    agentWithOtel: `curl -fsSL ${hub}/install.sh | sudo OTEL=1 bash`,
    agentNonInteractive: `curl -fsSL ${hub}/install.sh | sudo TOKEN=${token} bash`,
  };
}
