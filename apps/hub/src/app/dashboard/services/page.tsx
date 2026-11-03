import Link from "next/link";
import { redirect } from "next/navigation";
import { EmptyState } from "@/components/empty-state";
import { TraceWindowLinks, TracesTable } from "@/components/traces-table";
import { getSession } from "@/lib/auth/session";
import { isSetupComplete } from "@/lib/db/store";
import { formatSignal, listServices, type ServiceSummary } from "@/lib/otel/services";
import {
  formatMs,
  formatRate,
  listRecentTraces,
  listTraceServices,
  parseWindow,
  type TraceServiceStats,
} from "@/lib/otel/traces";

export const dynamic = "force-dynamic";

type Row = {
  service: string;
  traces: TraceServiceStats | null;
  metrics: ServiceSummary | null;
};

export default async function ServicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!(await isSetupComplete())) redirect("/setup");
  const session = await getSession();
  if (!session.isLoggedIn) redirect("/login");
  if (session.role === "admin" && !session.mfaVerified) redirect("/login");

  const orgId = session.orgId!;
  const win = parseWindow((await searchParams).window);
  const now = new Date();
  const since = new Date(now.getTime() - win.ms);
  const [metricServices, traceServices, recent] = await Promise.all([
    listServices(orgId),
    listTraceServices(orgId, { since, now }),
    listRecentTraces(orgId, { since, limit: 20 }),
  ]);

  const byName = new Map<string, Row>();
  for (const t of traceServices) {
    byName.set(t.service, { service: t.service, traces: t, metrics: null });
  }
  for (const m of metricServices) {
    const row = byName.get(m.service);
    if (row) row.metrics = m;
    else byName.set(m.service, { service: m.service, traces: null, metrics: m });
  }
  const rows = [...byName.values()];

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10">
      <header className="border-b border-border pb-6">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">
          Observe
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Services</h1>
        <p className="mt-2 text-sm text-muted">
          Rate / Errors / Duration per <span className="font-mono">service.name</span>.
          From trace entry spans when apps send OTLP traces; otherwise from HTTP or
          RPC metrics (24h). Raw points stay on{" "}
          <Link href="/dashboard/network" className="text-signal underline">
            Network
          </Link>
          .
        </p>
      </header>

      <section className="border border-border bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">Services</h2>
          <TraceWindowLinks basePath="/dashboard/services" current={win.key} />
        </div>
        {rows.length === 0 ? (
          <EmptyState
            action={
              <Link
                href="/dashboard/network"
                className="font-mono text-xs uppercase tracking-wide text-signal underline"
              >
                View raw OTEL points
              </Link>
            }
          >
            No named services yet. Send traces to the local collector
            (<span className="font-mono">OTEL_EXPORTER_OTLP_ENDPOINT</span>) or
            metrics to <span className="font-mono">/v1/metrics</span> with resource
            attribute <span className="font-mono">service.name</span> (see
            docs/otel.md).
          </EmptyState>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-[#f8fafb] font-mono text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Service</th>
                <th className="px-4 py-2 font-medium">Rate</th>
                <th className="px-4 py-2 font-medium">Errors</th>
                <th className="px-4 py-2 font-medium">p50</th>
                <th className="px-4 py-2 font-medium">p95</th>
                <th className="px-4 py-2 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <ServiceRow key={r.service} row={r} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            Recent traces
          </h2>
        </div>
        <TracesTable
          traces={recent}
          empty={
            <>
              No traces in the last {win.key}. Apps send OTLP to the local
              collector on <span className="font-mono">:4318</span>; it forwards to{" "}
              <span className="font-mono">/v1/traces</span>.
            </>
          }
        />
      </section>
    </main>
  );
}

function ServiceRow({ row }: { row: Row }) {
  const t = row.traces;
  const m = row.metrics;
  const lastSeen = t?.lastSeen ?? m?.lastSeen;
  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-4 py-3">
        <Link
          href={`/dashboard/services/${encodeURIComponent(row.service)}`}
          className="font-mono text-xs text-signal underline decoration-signal/30 underline-offset-2"
        >
          {row.service}
        </Link>
        <span className="ml-2 border border-border px-1 font-mono text-[10px] uppercase text-muted">
          {t ? "traces" : "metrics"}
        </span>
      </td>
      {t ? (
        <>
          <td className="px-4 py-3 font-mono text-xs">{formatRate(t.ratePerMin)}</td>
          <td
            className={`px-4 py-3 font-mono text-xs ${t.errorPct > 0 ? "text-danger" : ""}`}
          >
            {t.errorPct.toFixed(1)}%
          </td>
          <td className="px-4 py-3 font-mono text-xs">{formatMs(t.p50Ms)}</td>
          <td className="px-4 py-3 font-mono text-xs">{formatMs(t.p95Ms)}</td>
        </>
      ) : m ? (
        <>
          <td className="px-4 py-3 font-mono text-xs">
            {formatSignal(m.signals.rate, { activity: m.signals.rateIsActivity })}
          </td>
          <td className="px-4 py-3 font-mono text-xs">{formatSignal(m.signals.errors)}</td>
          <td className="px-4 py-3 font-mono text-xs">
            {formatSignal(m.signals.duration, { unit: m.signals.durationUnit })}
          </td>
          <td className="px-4 py-3 font-mono text-xs text-muted">—</td>
        </>
      ) : null}
      <td className="px-4 py-3 font-mono text-xs text-muted whitespace-nowrap">
        {lastSeen ? new Date(lastSeen).toISOString() : "—"}
      </td>
    </tr>
  );
}
