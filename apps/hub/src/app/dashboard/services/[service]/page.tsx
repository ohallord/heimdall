import Link from "next/link";
import { redirect } from "next/navigation";
import { EmptyState } from "@/components/empty-state";
import { Sparkline } from "@/components/sparkline";
import { getSession } from "@/lib/auth/session";
import { isSetupComplete } from "@/lib/db/store";
import { TraceWindowLinks, TracesTable } from "@/components/traces-table";
import { formatSignal, getServiceDetail } from "@/lib/otel/services";
import {
  formatMs,
  formatRate,
  listOperations,
  listRecentTraces,
  listTraceServices,
  parseWindow,
} from "@/lib/otel/traces";

export const dynamic = "force-dynamic";

function one(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s : undefined;
}

export default async function ServiceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ service: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!(await isSetupComplete())) redirect("/setup");
  const session = await getSession();
  if (!session.isLoggedIn) redirect("/login");
  if (session.role === "admin" && !session.mfaVerified) redirect("/login");

  const { service: raw } = await params;
  const service = decodeURIComponent(raw ?? "").trim();
  if (!service) redirect("/dashboard/services");

  const orgId = session.orgId!;
  const sp = await searchParams;
  const win = parseWindow(sp.window);
  const op = one(sp.op);
  const errorsOnly = one(sp.errors) === "1";
  const slow = one(sp.slow) === "1";
  const now = new Date();
  const since = new Date(now.getTime() - win.ms);

  const [detail, [stats], operations] = await Promise.all([
    getServiceDetail(orgId, service),
    listTraceServices(orgId, { since, now, service }),
    listOperations(orgId, service, { since, now }),
  ]);
  const traces = stats
    ? await listRecentTraces(orgId, {
        service,
        since,
        limit: 50,
        operation: op,
        errorsOnly,
        minDurationMs: slow ? stats.p95Ms : undefined,
      })
    : [];

  const base = `/dashboard/services/${encodeURIComponent(service)}`;
  const filterHref = (patch: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    const merged = {
      window: win.key,
      op,
      errors: errorsOnly ? "1" : undefined,
      slow: slow ? "1" : undefined,
      ...patch,
    };
    for (const [k, v] of Object.entries(merged)) if (v) q.set(k, v);
    return `${base}?${q.toString()}`;
  };

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10">
      <header className="border-b border-border pb-6">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">
          <Link href="/dashboard/services" className="hover:underline">
            Services
          </Link>
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight font-mono">
          {service}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {stats
            ? `${stats.count} requests in the last ${win.key} · last seen ${stats.lastSeen}`
            : null}
          {stats && detail.lastSeen ? " · " : null}
          {detail.lastSeen
            ? `${detail.sampleCount} metric samples (24h)`
            : stats
              ? null
              : "No traces or metric samples yet."}
        </p>
      </header>

      {stats ? (
        <>
          <section className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide">
              Traces · last {win.key}
            </h2>
            <TraceWindowLinks
              basePath={base}
              current={win.key}
              params={{
                op,
                errors: errorsOnly ? "1" : undefined,
                slow: slow ? "1" : undefined,
              }}
            />
          </section>
          <section className="grid gap-4 sm:grid-cols-4">
            <SignalTile label="Rate" value={formatRate(stats.ratePerMin)} />
            <SignalTile
              label="Errors"
              value={`${stats.errorPct.toFixed(1)}%`}
              warn={stats.errorPct > 0}
            />
            <SignalTile label="p50" value={formatMs(stats.p50Ms)} />
            <SignalTile label="p95" value={formatMs(stats.p95Ms)} />
          </section>

          <section className="border border-border bg-surface">
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide">
                Operations
              </h2>
            </div>
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-[#f8fafb] font-mono text-xs uppercase text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Operation</th>
                  <th className="px-4 py-2 font-medium">Rate</th>
                  <th className="px-4 py-2 font-medium">Errors</th>
                  <th className="px-4 py-2 font-medium">p50</th>
                  <th className="px-4 py-2 font-medium">p95</th>
                </tr>
              </thead>
              <tbody>
                {operations.map((o) => (
                  <tr
                    key={o.name}
                    className={`border-b border-border last:border-0 ${
                      o.name === op ? "bg-[#f8fafb]" : ""
                    }`}
                  >
                    <td className="max-w-[20rem] truncate px-4 py-2 font-mono text-xs">
                      <Link
                        href={filterHref({
                          op: o.name === op ? undefined : o.name,
                        })}
                        className="text-signal underline decoration-signal/30 underline-offset-2"
                        title={o.name}
                      >
                        {o.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">
                      {formatRate(o.ratePerMin)}
                    </td>
                    <td
                      className={`px-4 py-2 font-mono text-xs ${
                        o.errorPct > 0 ? "text-danger" : ""
                      }`}
                    >
                      {o.errorPct.toFixed(1)}%
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">
                      {formatMs(o.p50Ms)}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">
                      {formatMs(o.p95Ms)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="border border-border bg-surface">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide">
                Traces
                {op ? (
                  <span className="ml-2 font-mono normal-case">{op}</span>
                ) : null}
              </h2>
              <nav
                className="flex gap-1 font-mono text-xs"
                aria-label="Trace filters"
              >
                <FilterLink
                  href={filterHref({ errors: errorsOnly ? undefined : "1" })}
                  on={errorsOnly}
                >
                  Errors only
                </FilterLink>
                <FilterLink
                  href={filterHref({ slow: slow ? undefined : "1" })}
                  on={slow}
                >
                  Slow (&gt; p95)
                </FilterLink>
                {op || errorsOnly || slow ? (
                  <FilterLink href={`${base}?window=${win.key}`} on={false}>
                    Clear
                  </FilterLink>
                ) : null}
              </nav>
            </div>
            <TracesTable
              traces={traces}
              empty="No traces match these filters in this window."
            />
          </section>
        </>
      ) : null}

      {detail.lastSeen || !stats ? (
        <>
          <section className="grid gap-4 sm:grid-cols-3">
            <SignalTile
              label={detail.signals.rateIsActivity ? "Activity" : "Rate"}
              value={formatSignal(detail.signals.rate, {
                activity: detail.signals.rateIsActivity,
              })}
            />
            <SignalTile
              label="Errors"
              value={formatSignal(detail.signals.errors)}
              warn={detail.signals.errors != null && detail.signals.errors > 0}
            />
            <SignalTile
              label="Duration"
              value={formatSignal(detail.signals.duration, {
                unit: detail.signals.durationUnit,
              })}
            />
          </section>

          {detail.series.length > 0 ? (
            <section className="grid gap-4 md:grid-cols-2">
              {detail.series.map((s) => (
                <div
                  key={s.metricName}
                  className="border border-border bg-surface p-4"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <h2 className="font-mono text-xs uppercase tracking-wide text-muted">
                      {s.metricName}
                    </h2>
                    <span className="font-mono text-xs">
                      {formatSignal(s.latestValue, { unit: s.unit })}
                    </span>
                  </div>
                  <div className="mt-3">
                    <Sparkline values={s.values} width={280} height={40} />
                  </div>
                </div>
              ))}
            </section>
          ) : null}

          <section className="border border-border bg-surface">
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide">
                Recent points
              </h2>
            </div>
            {detail.recent.length === 0 ? (
              <EmptyState
                action={
                  <Link
                    href="/dashboard/services"
                    className="font-mono text-xs uppercase tracking-wide text-signal underline"
                  >
                    Back to services
                  </Link>
                }
              >
                No OTEL samples for this service in the lookback window. Confirm{" "}
                <span className="font-mono">service.name</span> on the collector
                resource.
              </EmptyState>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border bg-[#f8fafb] font-mono text-xs uppercase text-muted">
                  <tr>
                    <th className="px-4 py-2 font-medium">When</th>
                    <th className="px-4 py-2 font-medium">Metric</th>
                    <th className="px-4 py-2 font-medium">Value</th>
                    <th className="px-4 py-2 font-medium">Host</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.recent.map((r) => (
                    <tr
                      key={r.id}
                      className="border-b border-border last:border-0"
                    >
                      <td className="px-4 py-3 font-mono text-xs text-muted whitespace-nowrap">
                        {new Date(r.collected_at).toISOString()}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {r.metric_name}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {formatSignal(r.value, { unit: r.unit })}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted">
                        {r.resource_host ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      ) : null}
    </main>
  );
}

function SignalTile({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="border border-border bg-surface px-4 py-3">
      <p className="font-mono text-xs uppercase tracking-wide text-muted">
        {label}
      </p>
      <p
        className={`mt-1 font-mono text-2xl tracking-tight ${
          warn ? "text-danger" : "text-foreground"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function FilterLink({
  href,
  on,
  children,
}: {
  href: string;
  on: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-pressed={on}
      className={`border px-2 py-1 uppercase ${
        on
          ? "border-signal text-signal"
          : "border-border text-muted hover:border-signal"
      }`}
    >
      {children}
    </Link>
  );
}
