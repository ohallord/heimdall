import { redirect } from "next/navigation";
import { ContainersTable } from "@/components/containers-table";
import { listAgents } from "@/lib/agents";
import { getSession } from "@/lib/auth/session";
import { isSetupComplete } from "@/lib/db/store";
import type { ContainerMetric } from "@/lib/db/types";
import { listLatestContainers } from "@/lib/metrics/ingest";

export const dynamic = "force-dynamic";

export default async function ContainersPage() {
  if (!(await isSetupComplete())) redirect("/setup");
  const session = await getSession();
  if (!session.isLoggedIn) redirect("/login");
  if (session.role === "admin" && !session.mfaVerified) redirect("/login");

  const agents = await listAgents(session.orgId);
  const containerRows = session.orgId
    ? await listLatestContainers(session.orgId)
    : [];
  const byAgent = new Map(containerRows.map((row) => [row.agent_id, row]));
  const allContainers: Array<
    ContainerMetric & { agentId: string; hostname: string }
  > = [];
  for (const agent of agents) {
    const row = byAgent.get(agent.id);
    if (!row) continue;
    const items = JSON.parse(row.containers_json) as ContainerMetric[];
    for (const c of items) {
      allContainers.push({ ...c, agentId: agent.id, hostname: agent.hostname });
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10">
      <header className="border-b border-border pb-6">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">
          Containers
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Containers
        </h1>
        <p className="mt-2 text-sm text-muted">
          Docker/Podman samples across hosts. Bare-metal agents without a socket
          stay off host detail; this page is the dedicated containers view.
        </p>
      </header>

      <section className="border border-border bg-surface">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            All containers
          </h2>
          <span className="font-mono text-xs text-muted">
            {allContainers.length} reported
          </span>
        </div>
        <ContainersTable
          containers={allContainers}
          showHost
          emptyMessage="No container samples yet. Mount the Docker/Podman socket on an agent (Compose/systemd) to scrape containers."
        />
      </section>
    </main>
  );
}
