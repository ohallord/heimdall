import Link from "next/link";
import { safeHttpUrl } from "@/lib/security/safe-url";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { FindingResolveButton } from "@/components/finding-resolve-button";
import { getSession } from "@/lib/auth/session";
import { isSetupComplete } from "@/lib/db/store";
import { getFinding } from "@/lib/security/store";

export const dynamic = "force-dynamic";

export default async function FindingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!(await isSetupComplete())) redirect("/setup");
  const session = await getSession();
  if (!session.isLoggedIn) redirect("/login");
  if (session.role === "admin" && !session.mfaVerified) redirect("/login");

  const { id } = await params;
  const finding = session.orgId ? await getFinding(session.orgId, id) : null;
  if (!finding) notFound();

  let rawPretty = finding.raw_json;
  try {
    rawPretty = JSON.stringify(JSON.parse(finding.raw_json || "{}"), null, 2);
  } catch {
    /* keep raw */
  }

  const canResolve =
    finding.status === "open" &&
    (session.role === "admin" || session.role === "operator");

  const severityClass =
    finding.severity === "critical" || finding.severity === "high"
      ? "text-danger"
      : finding.severity === "medium"
        ? "text-warn"
        : "text-muted";

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-10">
      <header className="border-b border-border pb-6">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">
          Security · finding
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          {finding.title}
        </h1>
        <p className="mt-2 font-mono text-xs text-muted">
          {finding.id} · {finding.source} ·{" "}
          <span className={severityClass}>{finding.severity}</span> ·{" "}
          {finding.status}
        </p>
        <p className="mt-3 text-sm">
          <Link href="/dashboard/security" className="text-signal underline">
            ← Open findings
          </Link>
        </p>
      </header>

      <section className="grid gap-3 border border-border bg-surface p-4 text-sm sm:grid-cols-2">
        <Field label="CVE" value={finding.cve ?? "—"} />
        <Field
          label="Package"
          value={
            finding.package_name
              ? `${finding.package_name}@${finding.package_version ?? "?"}`
              : "—"
          }
        />
        <Field label="Fixed version" value={finding.fixed_version ?? "—"} />
        <Field label="Resource" value={finding.resource ?? "—"} />
        <Field
          label="Asset"
          value={
            finding.agent_id ? (
              <Link
                href={`/dashboard/hosts/${finding.agent_id}`}
                className="text-signal underline"
              >
                Host {finding.agent_id}
              </Link>
            ) : (
              (finding.resource ?? "—")
            )
          }
        />
        <Field
          label="Advisory"
          value={
            safeHttpUrl(finding.url) ? (
              <a
                href={safeHttpUrl(finding.url)!}
                className="text-signal underline"
                target="_blank"
                rel="noreferrer"
              >
                {finding.url}
              </a>
            ) : (
              "—"
            )
          }
        />
        <Field
          label="First seen"
          value={new Date(finding.first_seen_at).toISOString()}
        />
        <Field
          label="Last seen"
          value={new Date(finding.last_seen_at).toISOString()}
        />
        {finding.resolved_at ? (
          <Field
            label="Resolved at"
            value={new Date(finding.resolved_at).toISOString()}
          />
        ) : null}
        <Field label="External id" value={finding.external_id} />
      </section>

      {canResolve ? <FindingResolveButton findingId={finding.id} /> : null}

      <section className="border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            Source metadata
          </h2>
        </div>
        <pre className="overflow-x-auto p-4 font-mono text-xs text-muted">
          {rawPretty}
        </pre>
      </section>
    </main>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div>
      <p className="font-mono text-xs uppercase tracking-wide text-muted">
        {label}
      </p>
      <div className="mt-1 break-all">{value}</div>
    </div>
  );
}
