import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/dashboard-shell";
import { getSession } from "@/lib/auth/session";
import {
  findUserById,
  getPrimaryOrg,
  isSetupComplete,
  listAlertEvents,
} from "@/lib/db/store";

export const dynamic = "force-dynamic";

async function logoutAction() {
  "use server";
  const session = await getSession();
  session.destroy();
  redirect("/login");
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Pages still enforce auth; shell soft-loads chrome when logged in.
  const setup = await isSetupComplete();
  if (!setup) {
    return <>{children}</>;
  }

  const session = await getSession();
  if (!session.isLoggedIn) {
    return <>{children}</>;
  }

  const user = session.userId ? await findUserById(session.userId) : null;
  const org = await getPrimaryOrg();
  const openAlarms = session.orgId
    ? await listAlertEvents(session.orgId, {
        limit: 200,
        status: "open_queue",
      })
    : [];

  return (
    <DashboardShell
      orgName={org?.name}
      userLabel={
        user
          ? `${user.email} · ${user.role}`
          : session.role
            ? `role ${session.role}`
            : null
      }
      openAlarmsCount={openAlarms.length}
      logoutAction={logoutAction}
    >
      {children}
    </DashboardShell>
  );
}
