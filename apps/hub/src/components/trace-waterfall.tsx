import Link from "next/link";
import { formatMs, type WaterfallRow } from "@/lib/otel/traces";

/** Server-rendered span waterfall (Phase 30). No client JS. */
export function TraceWaterfall({
  rows,
  traceStart,
}: {
  rows: WaterfallRow[];
  traceStart: number;
}) {
  return (
    <ol className="divide-y divide-border">
      {rows.map(({ span, depth, offsetPct, widthPct, orphan }) => {
        const isError = span.status_code === "error";
        const attrs = Object.entries(span.attributes).sort(([a], [b]) =>
          a.localeCompare(b),
        );
        const relStart = Date.parse(span.start_at) - traceStart;
        return (
          <li key={span.span_id}>
            <details className="group">
              <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-3 px-4 py-1.5 hover:bg-[#f8fafb]">
                <span
                  className="flex min-w-0 items-center gap-2 text-xs"
                  style={{ paddingLeft: `${Math.min(depth, 12) * 12}px` }}
                >
                  <span
                    className={`font-mono text-[10px] uppercase ${
                      isError ? "text-danger" : "text-muted"
                    }`}
                  >
                    {span.service_name}
                  </span>
                  <span
                    className={`truncate font-mono ${isError ? "text-danger" : ""}`}
                    title={span.name}
                  >
                    {span.name}
                  </span>
                  {orphan ? (
                    <span className="border border-border px-1 font-mono text-[10px] uppercase text-muted">
                      orphan
                    </span>
                  ) : null}
                </span>
                <span className="relative h-4 w-full">
                  <span
                    className={`absolute top-0.5 h-3 ${
                      isError ? "bg-danger" : "bg-signal"
                    }`}
                    style={{ left: `${offsetPct}%`, width: `${widthPct}%` }}
                  />
                  <span
                    className="absolute top-0 font-mono text-[10px] text-muted"
                    style={
                      offsetPct + widthPct > 80
                        ? { right: `${100 - offsetPct + 1}%` }
                        : { left: `${offsetPct + widthPct + 1}%` }
                    }
                  >
                    {formatMs(span.duration_ms)}
                  </span>
                </span>
              </summary>
              <dl className="grid grid-cols-[10rem_minmax(0,1fr)] gap-x-4 gap-y-1 border-t border-border bg-[#f8fafb] px-4 py-3 font-mono text-xs">
                <dt className="text-muted">span</dt>
                <dd className="break-all">{span.span_id}</dd>
                <dt className="text-muted">service</dt>
                <dd>
                  <Link
                    href={`/dashboard/services/${encodeURIComponent(span.service_name)}`}
                    className="text-signal underline"
                  >
                    {span.service_name}
                  </Link>
                </dd>
                <dt className="text-muted">kind</dt>
                <dd>{span.kind}</dd>
                <dt className="text-muted">status</dt>
                <dd className={isError ? "text-danger" : ""}>
                  {span.status_code}
                  {span.status_message ? ` — ${span.status_message}` : ""}
                </dd>
                <dt className="text-muted">start</dt>
                <dd>+{formatMs(relStart)}</dd>
                <dt className="text-muted">duration</dt>
                <dd>{formatMs(span.duration_ms)}</dd>
                {span.resource_host ? (
                  <>
                    <dt className="text-muted">host</dt>
                    <dd>{span.resource_host}</dd>
                  </>
                ) : null}
                {attrs.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="truncate text-muted" title={k}>
                      {k}
                    </dt>
                    <dd className="break-all">{v}</dd>
                  </div>
                ))}
              </dl>
            </details>
          </li>
        );
      })}
    </ol>
  );
}
