import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readManifest, renderInstallScript, resolveDistFile, safeHubUrl } from "./index";
import { GET as downloadGet } from "@/app/downloads/[name]/route";
import { GET as installGet } from "@/app/install.sh/route";
import { resetRateLimits } from "@/lib/http-guard/rate-limit";

const SCRIPT = `#!/usr/bin/env bash
HUB_URL="\${HUB_URL:-__HEIMDALL_HUB_URL__}"
case "$HUB_URL" in __HEIMDALL_*) HUB_URL="" ;; esac
`;

let dir: string;

function seed() {
  writeFileSync(join(dir, "heimdall-agent-linux-amd64"), "ELF-ish");
  writeFileSync(join(dir, "install-host.sh"), SCRIPT);
  writeFileSync(join(dir, "secret.txt"), "not listed");
  writeFileSync(
    join(dir, "SHA256SUMS"),
    [
      `${"a".repeat(64)}  heimdall-agent-linux-amd64`,
      `${"b".repeat(64)}  install-host.sh`,
      `${"c".repeat(64)}  ../etc/passwd`,
      "garbage line",
    ].join("\n"),
  );
}

const get = (name: string) =>
  downloadGet(new Request(`http://hub.test/downloads/${name}`), {
    params: Promise.resolve({ name }),
  });

describe("hub dist downloads", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hd-dist-"));
    process.env.HEIMDALL_DIST_DIR = dir;
    delete process.env.HEIMDALL_PUBLIC_URL;
    resetRateLimits();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HEIMDALL_DIST_DIR;
  });

  it("reads only well-formed, path-free manifest names", async () => {
    seed();
    const m = await readManifest();
    expect(m && [...m.keys()].sort()).toEqual(["SHA256SUMS", "heimdall-agent-linux-amd64", "install-host.sh"]);
    expect(await resolveDistFile("secret.txt")).toBeNull();
    expect(await resolveDistFile("../etc/passwd")).toBeNull();
    expect(await resolveDistFile("install-host.sh")).toBe(join(dir, "install-host.sh"));
  });

  it("serves listed files with length and type", async () => {
    seed();
    const bin = await get("heimdall-agent-linux-amd64");
    expect(bin.status).toBe(200);
    expect(bin.headers.get("content-type")).toBe("application/octet-stream");
    expect(bin.headers.get("content-length")).toBe("7");
    expect(await bin.text()).toBe("ELF-ish");
    const sums = await get("SHA256SUMS");
    expect(sums.status).toBe(200);
    expect(sums.headers.get("content-type")).toContain("text/plain");
  });

  it("404s unlisted names and traversal attempts", async () => {
    seed();
    for (const name of ["secret.txt", "../SHA256SUMS", "%2e%2e%2fSHA256SUMS", "..", ""]) {
      expect((await get(name)).status).toBe(404);
    }
  });

  it("404s with a build hint when the hub has no dist", async () => {
    rmSync(dir, { recursive: true, force: true });
    const res = await get("SHA256SUMS");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("build-dist.sh");
  });
});

describe("/install.sh", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hd-dist-"));
    process.env.HEIMDALL_DIST_DIR = dir;
    delete process.env.HEIMDALL_PUBLIC_URL;
    resetRateLimits();
    seed();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HEIMDALL_DIST_DIR;
    delete process.env.HEIMDALL_PUBLIC_URL;
  });

  it("bakes in HEIMDALL_PUBLIC_URL", async () => {
    process.env.HEIMDALL_PUBLIC_URL = "https://heimdall.example.com/";
    const res = await installGet(new Request("http://10.0.0.5:43123/install.sh"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/x-shellscript");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain('HUB_URL="${HUB_URL:-https://heimdall.example.com}"');
    expect(body).toContain("__HEIMDALL_*)"); // the unrendered-guard survives
  });

  it("falls back to the request origin", async () => {
    const body = await (await installGet(new Request("http://hub.lan:43123/install.sh"))).text();
    expect(body).toContain('HUB_URL="${HUB_URL:-http://hub.lan:43123}"');
  });

  it("never bakes a URL with shell metacharacters", () => {
    expect(safeHubUrl("https://h.example.com")).toBe("https://h.example.com");
    expect(safeHubUrl("https://h.example.com/$(id)")).toBeNull();
    expect(safeHubUrl('https://h"; rm -rf / #')).toBeNull();
    expect(safeHubUrl("ftp://h")).toBeNull();
    expect(renderInstallScript(SCRIPT, null)).toContain("__HEIMDALL_HUB_URL__");
  });
});
