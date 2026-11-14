import { redirect } from "next/navigation";
import { BackupPanel } from "@/components/backup-panel";
import { OidcProviderForm } from "@/components/oidc-provider-form";
import { SecuritySyncSchedulePanel } from "@/components/security-sync-schedule-panel";
import { getSession } from "@/lib/auth/session";
import { isSetupComplete } from "@/lib/db/store";
import { listOidcProviders } from "@/lib/oidc/store";
import { can } from "@/lib/rbac/permissions";
import { getSecuritySyncSchedule } from "@/lib/security/schedule";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  if (!(await isSetupComplete())) redirect("/setup");
  const session = await getSession();
  if (!session.isLoggedIn) redirect("/login");
  if (session.role === "admin" && !session.mfaVerified) redirect("/login");
  if (!can(session.role!, "settings:write")) redirect("/dashboard");

  const providers = session.orgId
    ? await listOidcProviders(session.orgId)
    : [];
  const schedule = session.orgId
    ? await getSecuritySyncSchedule(session.orgId)
    : null;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-6 py-10">
      <header className="border-b border-border pb-6">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">
          Admin
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Identity, backup & schedules
        </h1>
        <p className="mt-2 text-sm text-muted">
          Configure BYO OIDC and export/restore org configuration. Local users
          and MFA remain available alongside SSO.
        </p>
      </header>

      <OidcProviderForm
        initial={providers.map((p) => ({
          id: p.id,
          name: p.name,
          issuer: p.issuer,
          clientId: p.client_id,
          scopes: p.scopes,
          enabled: p.enabled,
        }))}
      />

      {schedule ? <SecuritySyncSchedulePanel initial={schedule} /> : null}

      <BackupPanel />
    </main>
  );
}
