import { redirect } from "next/navigation";
import { UptimePanel } from "@/components/uptime-panel";
import { getSession } from "@/lib/auth/session";
import { isSetupComplete } from "@/lib/db/store";
import { can } from "@/lib/rbac/permissions";
import { listUptimeChecks, toView } from "@/lib/uptime/store";

export const dynamic = "force-dynamic";

export default async function UptimePage() {
  if (!(await isSetupComplete())) redirect("/setup");
  const session = await getSession();
  if (!session.isLoggedIn) redirect("/login");
  if (session.role === "admin" && !session.mfaVerified) redirect("/login");

  const checks = session.orgId ? (await listUptimeChecks(session.orgId)).map(toView) : [];

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10">
      <header className="border-b border-border pb-6">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">Uptime</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Synthetic checks</h1>
        <p className="mt-2 text-sm text-muted">
          Probe a URL, a TCP port or a TLS certificate from the hub. A check that keeps failing for the alert sustain
          window opens an alarm and notifies your channels; it resolves and sends a recovery when it passes again.
        </p>
      </header>
      <UptimePanel initial={checks} canWrite={can(session.role!, "alerts:write")} />
    </main>
  );
}
