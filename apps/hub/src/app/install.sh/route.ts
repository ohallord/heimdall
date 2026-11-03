import { guardRate } from "@/lib/http-guard/ingest";
import { hubUrlFor, readInstallScript, renderInstallScript } from "@/lib/host-dist";

export const dynamic = "force-dynamic";

/** `curl -fsSL <hub>/install.sh | sudo bash` — the host bootstrapper, HUB_URL baked in. */
export async function GET(request: Request) {
  const limited = guardRate(request, { name: "INGEST", route: "install.sh" });
  if (limited) return limited;
  const script = await readInstallScript();
  if (!script) {
    return new Response("echo 'error: this hub has no install-host.sh' >&2; exit 1\n", {
      status: 404,
      headers: { "content-type": "text/x-shellscript; charset=utf-8" },
    });
  }
  return new Response(renderInstallScript(script, hubUrlFor(request)), {
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
