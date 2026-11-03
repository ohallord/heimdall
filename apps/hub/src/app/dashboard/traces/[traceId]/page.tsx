import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { TraceWaterfall } from "@/components/trace-waterfall";
import { getSession } from "@/lib/auth/session";
import { isSetupComplete } from "@/lib/db/store";
import { buildWaterfall, formatMs, getTrace } from "@/lib/otel/traces";

export const dynamic = "force-dynamic";

export default async function TracePage({
  params,
}: {
  params: Promise<{ traceId: string }>;
}) {
  if (!(await isSetupComplete())) redirect("/setup");
  const session = await getSession();
  if (!session.isLoggedIn) redirect("/login");
  if (session.role === "admin" && !session.mfaVerified) redirect("/login");

  const { traceId: raw } = await params;
  const traceId = (raw ?? "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(traceId)) notFound();

  const spans = await getTrace(session.orgId!, traceId);
  if (spans.length === 0) notFound();

  const rows = buildWaterfall(spans);
  const root = rows[0].span;
  const traceStart = Math.min(...spans.map((s) => Date.parse(s.start_at)));
  const traceEnd = Math.max(
    ...spans.map((s) => Date.parse(s.start_at) + s.duration_ms),
  );
  const errors = spans.filter((s) => s.status_code === "error").length;
  const services = [...new Set(spans.map((s) => s.service_name))].sort();

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
      <header className="border-b border-border pb-6">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">
          <Link href="/dashboard/services" className="hover:underline">
            Services
          </Link>
          {" / "}
          <Link
            href={`/dashboard/services/${encodeURIComponent(root.service_name)}`}
            className="hover:underline"
          >
            {root.service_name}
          </Link>
          {" / trace"}
        </p>
        <h1 className="mt-2 break-all font-mono text-2xl font-semibold tracking-tight">
          {root.name}
        </h1>
        <p className="mt-2 font-mono text-xs text-muted break-all">{traceId}</p>
      </header>

      <section className="grid gap-4 sm:grid-cols-4">
        <Tile label="Duration" value={formatMs(traceEnd - traceStart)} />
        <Tile label="Spans" value={String(spans.length)} />
        <Tile label="Errors" value={String(errors)} warn={errors > 0} />
        <Tile label="Started" value={new Date(traceStart).toISOString().slice(11, 23)} />
      </section>

      <section className="border border-border bg-surface">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">Waterfall</h2>
          <p className="font-mono text-xs text-muted">
            {services.map((s, i) => (
              <span key={s}>
                {i > 0 ? " · " : ""}
                <Link
                  href={`/dashboard/services/${encodeURIComponent(s)}`}
                  className="text-signal underline"
                >
                  {s}
                </Link>
              </span>
            ))}
          </p>
        </div>
        {spans.length >= 5000 ? (
          <p className="border-b border-border px-4 py-2 text-xs text-muted">
            Showing the first 5000 spans.
          </p>
        ) : null}
        <TraceWaterfall rows={rows} traceStart={traceStart} />
      </section>
    </main>
  );
}

function Tile({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="border border-border bg-surface px-4 py-3">
      <p className="font-mono text-xs uppercase tracking-wide text-muted">{label}</p>
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
