import { listAgentsPersistent, listAlertChannels, listAlertRules, listUsersByOrg } from "@/lib/db/store";
import { listClusters, getOrgSettings } from "@/lib/clusters/store";
import { listOidcProviders } from "@/lib/oidc/store";
import { listSecurityConnections } from "@/lib/security/store";

export type BackupPayload = {
  version: 1;
  exportedAt: string;
  orgId: string;
  includeSecrets: boolean;
  clusters: Array<{
    clusterId: string;
    name: string;
    isActive: boolean;
  }>;
  settings: { activeClusterId: string };
  users: Array<{
    email: string;
    name: string;
    role: string;
    mfaEnrolled: boolean;
    oidcSub: string | null;
  }>;
  alertChannels: Array<{
    kind: string;
    enabled: boolean;
    config: Record<string, unknown>;
  }>;
  alertRules: Array<{
    name: string;
    metric: string;
    operator: string;
    threshold: number;
    warnThreshold?: number | null;
    alarmThreshold?: number | null;
    enabled: boolean;
  }>;
  remotes: Array<{
    kind: string;
    name: string;
    enabled: boolean;
    tokenHint: string | null;
    config: Record<string, unknown>;
  }>;
  oidcProviders: Array<{
    name: string;
    issuer: string;
    clientId: string;
    scopes: string;
    enabled: boolean;
    clientSecret?: string;
  }>;
  agents: Array<{
    hostname: string;
    version: string;
    clusterId: string;
  }>;
};

function redactConfig(
  config: Record<string, unknown>,
  includeSecrets: boolean,
): Record<string, unknown> {
  if (includeSecrets) return config;
  const out = { ...config };
  for (const key of ["token", "pass", "password", "authToken", "clientSecret"]) {
    if (key in out) out[key] = "[redacted]";
  }
  return out;
}

export async function buildOrgBackup(input: {
  orgId: string;
  includeSecrets?: boolean;
}): Promise<BackupPayload> {
  const includeSecrets = Boolean(input.includeSecrets);
  const [clusters, settings, users, channels, rules, remotes, oidc, agents] =
    await Promise.all([
      listClusters(input.orgId),
      getOrgSettings(input.orgId),
      listUsersByOrg(input.orgId),
      listAlertChannels(input.orgId),
      listAlertRules(input.orgId),
      listSecurityConnections(input.orgId),
      listOidcProviders(input.orgId),
      listAgentsPersistent(input.orgId),
    ]);

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    orgId: input.orgId,
    includeSecrets,
    clusters: clusters.map((c) => ({
      clusterId: c.cluster_id,
      name: c.name,
      isActive: Boolean(c.is_active),
    })),
    settings: { activeClusterId: settings.active_cluster_id },
    users: users.map((u) => ({
      email: u.email,
      name: u.name,
      role: u.role,
      mfaEnrolled: u.mfa_enrolled,
      oidcSub: u.oidc_sub,
    })),
    alertChannels: channels.map((c) => ({
      kind: c.kind,
      enabled: c.enabled,
      config: redactConfig(
        JSON.parse(c.config_json) as Record<string, unknown>,
        includeSecrets,
      ),
    })),
    alertRules: rules.map((r) => ({
      name: r.name,
      metric: r.metric,
      operator: r.operator,
      threshold: r.threshold,
      warnThreshold: r.warn_threshold,
      alarmThreshold: r.alarm_threshold ?? r.threshold,
      enabled: r.enabled,
    })),
    remotes: remotes.map((r) => ({
      kind: r.kind,
      name: r.name,
      enabled: r.enabled,
      tokenHint: r.token_hint,
      config: redactConfig(
        JSON.parse(r.config_json) as Record<string, unknown>,
        includeSecrets,
      ),
    })),
    oidcProviders: oidc.map((p) => ({
      name: p.name,
      issuer: p.issuer,
      clientId: p.client_id,
      scopes: p.scopes,
      enabled: p.enabled,
      ...(includeSecrets ? { clientSecret: p.client_secret } : {}),
    })),
    agents: agents.map((a) => ({
      hostname: a.hostname,
      version: a.version,
      clusterId: a.cluster_id,
    })),
  };
}
