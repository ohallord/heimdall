import { MetricHistoryPageShell } from "@/components/metric-history-page";

export const dynamic = "force-dynamic";

export default async function DiskHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ agentId: string }>;
  searchParams: Promise<{ mount?: string }>;
}) {
  const { agentId } = await params;
  const sp = await searchParams;
  const mount = sp.mount?.trim() || "/";
  return (
    <MetricHistoryPageShell
      agentId={agentId}
      metric="disk"
      mount={mount}
      title={`Disk % (${mount})`}
    />
  );
}
