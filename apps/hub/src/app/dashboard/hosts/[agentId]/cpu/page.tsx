import { MetricHistoryPageShell } from "@/components/metric-history-page";

export const dynamic = "force-dynamic";

export default async function CpuHistoryPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = await params;
  return (
    <MetricHistoryPageShell
      agentId={agentId}
      metric="cpu"
      title="CPU %"
    />
  );
}
