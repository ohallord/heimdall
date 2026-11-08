import Link from "next/link";
import { safeHttpUrl } from "@/lib/security/safe-url";
import { redirect } from "next/navigation";
import { EmptyState } from "@/components/empty-state";
import { SecurityScanActions } from "@/components/security-scan-actions";
import { getSession } from "@/lib/auth/session";
import { isSetupComplete } from "@/lib/db/store";
import type { VulnSource } from "@/lib/db/types";
import { listFindings, listSecurityConnections } from "@/lib/security/store";

export const dynamic = "force-dynamic";

const SOURCES: Array<{ value: "" | VulnSource; label: string }> = [
  { value: "", label: "All sources" },
  { value: "runtime", label: "Runtime" },
  { value: "host_posture", label: "Host posture" },
  { value: "trivy", label: "Trivy images" },
  { value: "osv", label: "OSV" },
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
];

function parseSource(raw: string | string[] | undefined): VulnSource | undefined {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (
    v === "trivy" ||
    v === "osv" ||
    v === "github" ||
    v === "gitlab" ||
    v === "host_posture" ||
    v === "runtime"
  ) {
    return v;
  }
  return undefined;
}

export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string | string[] }>;
}) {
  if (!(await isSetupComplete())) redirect("/setup");
  const session = await getSession();
  if (!session.isLoggedIn) redirect("/login");
  if (session.role === "admin" && !session.mfaVerified) redirect("/login");

  const sp = await searchParams;
  const source = parseSource(sp.source);
  const findings = session.orgId
    ? await listFindings(session.orgId, { source })
    : [];
  const connections = session.orgId
    ? await listSecurityConnections(session.orgId)
    : [];

  const counts = {
    critical: findings.filter((f) => f.severity === "critical").length,
    high: findings.filter((f) => f.severity === "high").length,
    medium: findings.filter((f) => f.severity === "medium").length,
    low: findings.filter((f) => f.severity === "low").length,
  };

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10">
      <header className="border-b border-border pb-6">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">
          Security
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Vulnerability findings
        </h1>
        <p className="mt-2 text-sm text-muted">
          Unified view across optional runtime/Falco signals, host posture
          (Trivy rootfs), Trivy images, OSV lockfiles, GitHub Dependabot /
          advisories, and GitLab project vulnerabilities. Remotes live under
          Security in the console nav.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-4">
        <Tile label="Critical" value={String(counts.critical)} warn={counts.critical > 0} />
        <Tile label="High" value={String(counts.high)} warn={counts.high > 0} />
        <Tile label="Medium" value={String(counts.medium)} />
        <Tile label="Low" value={String(counts.low)} />
      </section>

      <section className="border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide">
          Remotes
        </h2>
        {connections.length === 0 ? (
          <EmptyState
            action={
              <Link href="/dashboard/remotes" className="text-signal underline">
                Manage remotes
              </Link>
            }
          >
            No GitHub/GitLab tokens configured. Add them on Remotes or in the
            setup wizard.
          </EmptyState>
        ) : (
          <ul className="mt-2 space-y-1 font-mono text-xs">
            {connections.map((c) => (
              <li key={c.id}>
                {c.kind} · {c.name} · {c.token_hint ?? "****"}
                {c.enabled ? "" : " (off)"}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-sm">
          <Link href="/dashboard/remotes" className="text-signal underline">
            Manage remotes
          </Link>
        </p>
        <div className="mt-4">
          <SecurityScanActions />
        </div>
      </section>

      <section className="border border-border bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide">
            Open findings
          </h2>
          <nav
            className="flex flex-wrap gap-2 font-mono text-xs"
            aria-label="Filter by source"
          >
            {SOURCES.map((s) => {
              const href = s.value
                ? `/dashboard/security?source=${s.value}`
                : "/dashboard/security";
              const active = (source ?? "") === s.value;
              return (
                <Link
                  key={s.label}
                  href={href}
                  className={
                    active
                      ? "text-signal underline"
                      : "text-muted hover:text-foreground"
                  }
                >
                  {s.label}
                </Link>
              );
            })}
          </nav>
        </div>
        {findings.length === 0 ? (
          <EmptyState>
            No findings yet. Run host posture (`scan-host`), ingest a Trivy/OSV
            report, or sync remotes.
          </EmptyState>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-[#f8fafb] font-mono text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-2">Severity</th>
                <th className="px-4 py-2">Source</th>
                <th className="px-4 py-2">Title</th>
                <th className="px-4 py-2">Package</th>
                <th className="px-4 py-2">Resource</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((f) => (
                <tr key={f.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 font-mono text-xs">
                    <span
                      className={
                        f.severity === "critical" || f.severity === "high"
                          ? "text-danger"
                          : f.severity === "medium"
                            ? "text-warn"
                            : "text-muted"
                      }
                    >
                      {f.severity}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{f.source}</td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/dashboard/security/findings/${f.id}`}
                      className="text-signal underline"
                    >
                      {f.title}
                    </Link>
                    {f.cve ? (
                      <span className="ml-2 font-mono text-xs text-muted">
                        {f.cve}
                      </span>
                    ) : null}
                    {safeHttpUrl(f.url) ? (
                      <a
                        href={safeHttpUrl(f.url)!}
                        className="ml-2 font-mono text-xs text-muted underline"
                        target="_blank"
                        rel="noreferrer"
                      >
                        advisory
                      </a>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {f.package_name
                      ? `${f.package_name}@${f.package_version ?? "?"}`
                      : "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted">
                    {f.agent_id ? (
                      <Link
                        href={`/dashboard/hosts/${f.agent_id}`}
                        className="text-signal underline"
                      >
                        {f.resource ?? f.agent_id}
                      </Link>
                    ) : (
                      (f.resource ?? "—")
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

function Tile({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="border border-border bg-surface px-4 py-4">
      <p className="font-mono text-xs uppercase tracking-wide text-muted">
        {label}
      </p>
      <p
        className={`mt-2 text-2xl font-semibold ${warn ? "text-danger" : "text-foreground"}`}
      >
        {value}
      </p>
    </div>
  );
}
