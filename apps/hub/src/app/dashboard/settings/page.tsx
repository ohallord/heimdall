import { redirect } from "next/navigation";
import { AgentTokensPanel } from "@/components/agent-tokens-panel";
import { BootstrapWarning } from "@/components/bootstrap-warning";
import { bootstrapStatus } from "@/lib/agents/bootstrap";
import { can } from "@/lib/rbac/permissions";
import { CriticalFindingsAlarmsForm } from "@/components/critical-findings-alarms-form";
import { HostThresholdForm } from "@/components/host-threshold-form";
import { IntegrationsForm } from "@/components/integrations-form";
import { MetricsRetentionForm } from "@/components/metrics-retention-form";
import { NotificationPrefsForm } from "@/components/notification-prefs-form";
import { getSession } from "@/lib/auth/session";
import {
  ensureBootstrapOrg,
  getOrCreateNotificationPrefs,
  isSetupComplete,
  listAgentTokens,
  listAlertRules,
} from "@/lib/db/store";
import { ensureHostMetricRules } from "@/lib/metrics/ingest";
import {
  DEFAULT_RETENTION_DAYS,
  DEFAULT_TRACES_RETENTION_DAYS,
  getMetricsRetentionDays,
  getTracesRetentionDays,
} from "@/lib/metrics/retention";
import { getCriticalFindingsToAlarms } from "@/lib/security/settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  if (!(await isSetupComplete())) redirect("/setup");
  const session = await getSession();
  if (!session.isLoggedIn) redirect("/login");
  if (session.role === "admin" && !session.mfaVerified) redirect("/login");

  const prefs = await getOrCreateNotificationPrefs({
    userId: session.userId!,
    orgId: session.orgId!,
  });

  if (session.orgId) {
    await ensureHostMetricRules(session.orgId);
  }
  const allRules = session.orgId ? await listAlertRules(session.orgId) : [];
  const hostRules = allRules
    .filter((r) =>
      ["cpu_percent", "mem_percent", "disk_percent"].includes(r.metric),
    )
    .map((r) => ({
      id: r.id,
      name: r.name,
      metric: r.metric,
      warnThreshold: r.warn_threshold,
      alarmThreshold: r.alarm_threshold ?? r.threshold,
    }));

  const canEditThresholds = session.role === "admin" || session.role === "operator";
  const canWriteIntegrations = session.role === "admin";
  const retentionDays = session.orgId
    ? await getMetricsRetentionDays(session.orgId)
    : DEFAULT_RETENTION_DAYS;
  const tracesRetentionDays = session.orgId
    ? await getTracesRetentionDays(session.orgId)
    : DEFAULT_TRACES_RETENTION_DAYS;
  const canWriteAgents = Boolean(session.role && can(session.role, "agents:write"));
  const tokenRows = session.orgId ? await listAgentTokens(session.orgId) : [];
  const bootstrap = await bootstrapStatus();
  const canManageBootstrap =
    session.role === "admin" && (await ensureBootstrapOrg()).id === session.orgId;
  const criticalFindingsToAlarms = session.orgId
    ? await getCriticalFindingsToAlarms(session.orgId)
    : true;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-6 py-10">
      <header className="border-b border-border pb-6">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">
          Settings
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          Notifications & thresholds
        </h1>
        <p className="mt-2 text-sm text-muted">
          Per-user channel preferences, quiet hours, host warn/alarm bands,
          metric history retention, critical findings → Alarms, and UniFi /
          OTEL / runtime integration tokens. Critical alerts still fire during
          quiet hours.
        </p>
      </header>

      <BootstrapWarning role={session.role} />

      <AgentTokensPanel
        canWrite={canWriteAgents}
        bootstrap={{ ...bootstrap, canManage: canManageBootstrap }}
        tokens={tokenRows.map((t) => ({
          id: t.id,
          name: t.name,
          hint: t.token_hint,
          createdAt: new Date(t.created_at).toISOString(),
          expiresAt: t.expires_at ? new Date(t.expires_at).toISOString() : null,
          maxUses: t.max_uses,
          useCount: t.use_count,
          revokedAt: t.revoked_at ? new Date(t.revoked_at).toISOString() : null,
        }))}
      />

      {canEditThresholds ? (
        <HostThresholdForm initial={hostRules} />
      ) : (
        <p className="text-sm text-muted">
          Host threshold editing requires operator or admin role.
        </p>
      )}

      <MetricsRetentionForm
        initialDays={retentionDays}
        initialTracesDays={tracesRetentionDays}
        canEdit={canEditThresholds}
      />

      <CriticalFindingsAlarmsForm
        initialEnabled={criticalFindingsToAlarms}
        canEdit={canEditThresholds}
      />

      <IntegrationsForm canWrite={canWriteIntegrations} />

      <NotificationPrefsForm
        initial={{
          notifySmtp: prefs.notify_smtp,
          notifySlack: prefs.notify_slack,
          notifyDiscord: prefs.notify_discord,
          notifySms: prefs.notify_sms,
          smsPhone: prefs.sms_phone ?? "",
          quietHoursEnabled: prefs.quiet_hours_enabled,
          quietStart: prefs.quiet_start,
          quietEnd: prefs.quiet_end,
          timezone: prefs.timezone,
        }}
      />
    </main>
  );
}
