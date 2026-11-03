import { redirect } from "next/navigation";
import { AlarmsDashboard } from "@/components/alarms-dashboard";
import { areAlertsPaused } from "@/lib/alerts/pause";
import { serializeAlertEvent } from "@/lib/alerts/serialize";
import { getSession } from "@/lib/auth/session";
import { isSetupComplete, listAlertEvents } from "@/lib/db/store";
import { can } from "@/lib/rbac/permissions";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ id?: string; tab?: string; status?: string }>;

export default async function AlarmsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  if (!(await isSetupComplete())) redirect("/setup");
  const session = await getSession();
  if (!session.isLoggedIn) redirect("/login");
  if (session.role === "admin" && !session.mfaVerified) redirect("/login");

  const params = await searchParams;
  const orgId = session.orgId!;
  const [openRows, historyRows] = await Promise.all([
    listAlertEvents(orgId, { limit: 100, status: "open_queue" }),
    listAlertEvents(orgId, { limit: 100 }),
  ]);

  const openEvents = openRows.map(serializeAlertEvent);
  const historyEvents = historyRows.map(serializeAlertEvent);
  const canWrite = can(session.role!, "alerts:write");
  const initialTab =
    params.tab === "history" || params.status === "history"
      ? "history"
      : "open";

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
      <header className="border-b border-border pb-6">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">
          Alarms
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Alarm console
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Open queue with mute and dismiss. Alerts auto-close when the host recovers; bulk-dismiss clears old ones. History keeps closed events.
          Notifications include host context and a deep link back here.
        </p>
      </header>

      <AlarmsDashboard
        openEvents={openEvents}
        historyEvents={historyEvents}
        selectedId={params.id}
        initialTab={initialTab}
        canWrite={canWrite}
        alertsPaused={areAlertsPaused()}
      />
    </main>
  );
}
