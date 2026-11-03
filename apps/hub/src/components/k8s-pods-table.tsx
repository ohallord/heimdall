import Link from "next/link";
import type { K8sPodMetric } from "@/lib/db/types";
import { podDetailHref } from "@/lib/metrics/find-pod";
import {
  filterProblemPods,
  formatPodReady,
  podHealthTone,
  sortPodsForDisplay,
} from "@/lib/metrics/k8s-pods-display";

const toneClass: Record<ReturnType<typeof podHealthTone>, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  muted: "text-muted",
};

export function K8sPodsTable({
  pods,
  emptyMessage = "No pods in sample.",
  maxRows = 80,
  agentId,
  problemsOnly = false,
}: {
  pods: K8sPodMetric[];
  emptyMessage?: string;
  maxRows?: number;
  /** When set, pod links scope detail lookup to this agent's sample. */
  agentId?: string;
  /** When true, only show unhealthy pods. */
  problemsOnly?: boolean;
}) {
  const filtered = problemsOnly ? filterProblemPods(pods) : pods;
  const rows = sortPodsForDisplay(filtered).slice(0, maxRows);
  if (rows.length === 0) {
    return <p className="px-4 py-6 text-sm text-muted">{emptyMessage}</p>;
  }
  return (
    <table className="w-full text-left text-sm">
      <thead className="border-b border-border bg-[#f8fafb] font-mono text-xs uppercase text-muted">
        <tr>
          <th className="px-4 py-2 font-medium">Namespace</th>
          <th className="px-4 py-2 font-medium">Name</th>
          <th className="px-4 py-2 font-medium">Phase</th>
          <th className="px-4 py-2 font-medium">Ready</th>
          <th className="px-4 py-2 font-medium">Restarts</th>
          <th className="px-4 py-2 font-medium">Reason</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => {
          const tone = podHealthTone(p);
          return (
            <tr
              key={`${p.namespace}/${p.name}`}
              className="border-b border-border last:border-0"
            >
              <td className="px-4 py-2 font-mono text-xs text-muted">
                {p.namespace}
              </td>
              <td className="px-4 py-2 font-mono text-xs">
                <Link
                  href={podDetailHref(p.namespace, p.name, agentId)}
                  className="text-signal underline"
                >
                  {p.name}
                </Link>
              </td>
              <td className={`px-4 py-2 font-mono text-xs ${toneClass[tone]}`}>
                {p.phase}
              </td>
              <td className="px-4 py-2 font-mono text-xs">
                {formatPodReady(p.ready)}
              </td>
              <td className="px-4 py-2 font-mono text-xs">{p.restarts}</td>
              <td className="px-4 py-2 font-mono text-xs text-muted">
                {p.reason || "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
