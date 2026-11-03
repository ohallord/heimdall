import { MetricHistoryPageShell } from "@/components/metric-history-page";

export const dynamic = "force-dynamic";

export default async function MemoryHistoryPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = await params;
  return (
    <MetricHistoryPageShell
      agentId={agentId}
      metric="memory"
      title="Memory %"
    />
  );
}
