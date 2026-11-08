import { readFile } from "node:fs/promises";
import { guardRate } from "@/lib/http-guard/ingest";
import { DIST_MISSING_HINT, readManifest, resolveDistFile } from "@/lib/host-dist";

export const dynamic = "force-dynamic";

/** Public agent + installer downloads (Phase 31). Only names listed in SHA256SUMS are served. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const limited = guardRate(request, { name: "INGEST", route: "downloads" });
  if (limited) return limited;
  const { name } = await params;
  const path = await resolveDistFile(name);
  if (!path) {
    const msg = (await readManifest()) ? "not found" : DIST_MISSING_HINT;
    return new Response(`${msg}\n`, {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const data = await readFile(path);
  const binary = name.startsWith("heimdall-agent-");
  return new Response(new Uint8Array(data), {
    headers: {
      "content-type": binary ? "application/octet-stream" : "text/plain; charset=utf-8",
      "content-length": String(data.byteLength),
      "cache-control": "no-cache",
      ...(binary ? { "content-disposition": `attachment; filename="${name}"` } : {}),
    },
  });
}
