import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import {
  TRACE_WINDOWS,
  formatMs,
  type TraceSummary,
  type TraceWindowKey,
} from "@/lib/otel/traces";

/** Window selector as plain links; keeps other query params. */
export function TraceWindowLinks({
  basePath,
  current,
  params = {},
}: {
  basePath: string;
  current: TraceWindowKey;
  params?: Record<string, string | undefined>;
}) {
  return (
    <nav className="flex gap-1 font-mono text-xs" aria-label="Time window">
      {(Object.keys(TRACE_WINDOWS) as TraceWindowKey[]).map((key) => {
        const q = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
        q.set("window", key);
        const active = key === current;
        return (
          <Link
            key={key}
            href={`${basePath}?${q.toString()}`}
            aria-current={active ? "page" : undefined}
            className={`border px-2 py-1 uppercase ${
              active
                ? "border-signal text-signal"
                : "border-border text-muted hover:border-signal"
            }`}
          >
            {key}
          </Link>
        );
      })}
    </nav>
  );
}

export function TracesTable({
  traces,
  empty,
}: {
  traces: TraceSummary[];
  empty: React.ReactNode;
}) {
  if (traces.length === 0) return <EmptyState>{empty}</EmptyState>;
  return (
    <table className="w-full text-left text-sm">
      <thead className="border-b border-border bg-[#f8fafb] font-mono text-xs uppercase text-muted">
        <tr>
          <th className="px-4 py-2 font-medium">Started</th>
          <th className="px-4 py-2 font-medium">Root</th>
          <th className="px-4 py-2 font-medium">Service</th>
          <th className="px-4 py-2 font-medium">Duration</th>
          <th className="px-4 py-2 font-medium">Spans</th>
          <th className="px-4 py-2 font-medium">Errors</th>
        </tr>
      </thead>
      <tbody>
        {traces.map((t) => (
          <tr key={t.trace_id} className="border-b border-border last:border-0">
            <td className="px-4 py-2 font-mono text-xs text-muted whitespace-nowrap">
              {t.started_at.replace("T", " ").slice(0, 23)}
            </td>
            <td className="max-w-[18rem] truncate px-4 py-2 font-mono text-xs">
              <Link
                href={`/dashboard/traces/${t.trace_id}`}
                className="text-signal underline decoration-signal/30 underline-offset-2"
                title={t.root_name}
              >
                {t.root_name || t.trace_id.slice(0, 12)}
              </Link>
            </td>
            <td className="px-4 py-2 font-mono text-xs text-muted">{t.root_service}</td>
            <td className="px-4 py-2 font-mono text-xs">{formatMs(t.duration_ms)}</td>
            <td className="px-4 py-2 font-mono text-xs text-muted">{t.span_count}</td>
            <td
              className={`px-4 py-2 font-mono text-xs ${
                t.error_count > 0 ? "text-danger" : "text-muted"
              }`}
            >
              {t.error_count}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
