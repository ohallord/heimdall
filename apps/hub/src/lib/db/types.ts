export type Role = "admin" | "operator" | "viewer";

export type Organization = {
  id: string;
  name: string;
  setup_completed_at: string | null;
  created_at: string;
};

export type User = {
  id: string;
  org_id: string;
  email: string;
  name: string;
  password_hash: string;
  role: Role;
  mfa_enrolled: boolean;
  totp_secret: string | null;
  totp_pending: string | null;
  oidc_sub: string | null;
  oidc_provider_id: string | null;
  session_version?: number;
  totp_last_step?: string | number | null;
  created_at: string;
};

export type AgentRow = {
  id: string;
  org_id: string;
  token_id: string | null;
  hostname: string;
  version: string;
  cluster_id: string;
  registered_at: string;
  last_seen_at: string;
  secret_hash: string | null;
  revoked_at: string | null;
  legacy_warned_at: string | null;
};

export type ClusterRow = {
  id: string;
  org_id: string;
  cluster_id: string;
  name: string;
  is_active: boolean;
  created_at: string;
};

export type OrgSettingsRow = {
  org_id: string;
  active_cluster_id: string;
  settings_json: string;
  updated_at: string;
};

export type OidcProviderRow = {
  id: string;
  org_id: string;
  name: string;
  issuer: string;
  client_id: string;
  client_secret: string;
  scopes: string;
  enabled: boolean;
  created_at: string;
};

export type AgentTokenRow = {
  id: string;
  org_id: string;
  name: string;
  token_hash: string;
  token_hint: string;
  created_by: string | null;
  created_at: string;
  revoked_at: string | null;
  expires_at: string | null;
  max_uses: number | null;
  use_count: number;
};

export type AlertChannelKind = "smtp" | "slack" | "discord" | "sms";

export type AlertChannelRow = {
  id: string;
  org_id: string;
  kind: AlertChannelKind;
  enabled: boolean;
  config_json: string;
  created_at: string;
};

export type AlertRuleRow = {
  id: string;
  org_id: string;
  name: string;
  metric: string;
  operator: "gt" | "gte" | "lt" | "lte" | "eq";
  /** Alarm value (synced with alarm_threshold for host utilization rules). */
  threshold: number;
  warn_threshold: number | null;
  alarm_threshold: number | null;
  enabled: boolean;
  created_at: string;
};

export type AlertEventStatus = "open" | "muted" | "dismissed" | "resolved";

export type AlertEventRow = {
  id: string;
  org_id: string;
  rule_id: string | null;
  severity: string;
  message: string;
  payload_json: string;
  created_at: string;
  status: AlertEventStatus;
  fingerprint: string | null;
  muted_until: string | null;
  dismissed_at: string | null;
  dismissed_by: string | null;
  /** Set when the system recovered and the alert auto-closed (Phase 26). */
  resolved_at: string | null;
};

export type IntegrationTokenKind =
  | "unifi_webhook"
  | "otel_ingest"
  | "runtime_webhook";

export type IntegrationTokenRow = {
  id: string;
  org_id: string;
  kind: IntegrationTokenKind;
  token_hash: string;
  token_hint: string | null;
  created_at: string;
};

export type OtelMetricSampleRow = {
  id: string;
  org_id: string;
  resource_service: string | null;
  resource_host: string | null;
  agent_id: string | null;
  metric_name: string;
  unit: string | null;
  attributes_json: string;
  value: number;
  collected_at: string;
  created_at: string;
};

export type NotificationPrefsRow = {
  user_id: string;
  org_id: string;
  notify_smtp: boolean;
  notify_slack: boolean;
  notify_discord: boolean;
  notify_sms: boolean;
  sms_phone: string | null;
  quiet_hours_enabled: boolean;
  quiet_start: string;
  quiet_end: string;
  timezone: string;
  updated_at: string;
};

export type MountMetric = {
  path: string;
  present: boolean;
  fsType?: string;
  device?: string;
  totalBytes?: number;
  usedBytes?: number;
  usedPercent?: number;
};

export type DiskMetric = {
  mountPoint: string;
  device: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
};

export type MetricSampleRow = {
  id: string;
  agent_id: string;
  org_id: string;
  collected_at: string;
  cpu_percent: number;
  mem_percent: number;
  mem_used_bytes: number;
  mem_total_bytes: number;
  load1: number;
  load5: number;
  load15: number;
  disks_json: string;
  mounts_json: string;
  created_at?: string;
};

export type MetricLatestRow = Omit<MetricSampleRow, "id" | "created_at"> & {
  updated_at: string;
};

export type ContainerMetric = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  restartCount: number;
  exitCode?: number | null;
  oomKilled?: boolean;
  restartLoop?: boolean;
  cpuPercent?: number | null;
  memUsageBytes?: number | null;
  memLimitBytes?: number | null;
  memPercent?: number | null;
  startedAt?: string;
  finishedAt?: string;
  /**
   * Hub-set: this container stopped abnormally while monitored (seen running,
   * then exited/dead with a non-zero code). Carried forward on each ingest
   * while it stays down so the alert stays open; never sent by the agent.
   */
  exitAlert?: boolean;
};

export type ContainersLatestRow = {
  agent_id: string;
  org_id: string;
  runtime: string;
  containers_json: string;
  collected_at: string;
  updated_at: string;
};

export type K8sNodeMetric = {
  name: string;
  ready: boolean;
  reason?: string;
  message?: string;
};

export type K8sPodProblemMetric = {
  namespace: string;
  name: string;
  phase: string;
  reason?: string;
  restarts: number;
  problem: string;
};

export type K8sPodConditionMetric = {
  type: string;
  status: string;
  reason?: string;
  message?: string;
};

export type K8sPodContainerMetric = {
  name: string;
  image?: string;
  ready: boolean;
  restarts: number;
  state?: string;
  reason?: string;
};

export type K8sPodResourcesMetric = {
  cpuRequest?: string;
  cpuLimit?: string;
  memRequest?: string;
  memLimit?: string;
};

export type K8sPodEventMetric = {
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  lastTimestamp?: string;
};

export type K8sPodMetric = {
  namespace: string;
  name: string;
  phase: string;
  ready: string;
  restarts: number;
  reason?: string;
  healthy: boolean;
  nodeName?: string;
  createdAt?: string;
  conditions?: K8sPodConditionMetric[];
  containers?: K8sPodContainerMetric[];
  resources?: K8sPodResourcesMetric | null;
  events?: K8sPodEventMetric[];
  logTail?: string;
};

export type K8sDeploymentMetric = {
  namespace: string;
  name: string;
  desired: number;
  ready: number;
  available: number;
  healthy: boolean;
};

/** NodePort / LoadBalancer / ExternalIP Services (Phase 21). */
export type K8sServiceExposureMetric = {
  namespace: string;
  name: string;
  type: string;
  externalIPs?: string[];
  nodePorts?: number[];
  loadBalancerHosts?: string[];
};

export type K8sNetworkPolicySummary = {
  namespacesTotal: number;
  namespacesWithPolicy: number;
  namespacesWithoutPolicy: number;
  /** Capped list of namespaces with zero NetworkPolicies. */
  withoutPolicy?: string[];
};

export type K8sClusterMetric = {
  /** When false, collection is off — UI must not show API "down". */
  enabled?: boolean;
  clusterId: string;
  apiServerReachable: boolean;
  apiServerLatencyMs?: number;
  apiServerError?: string;
  nodesTotal: number;
  nodesReady: number;
  nodesNotReady?: K8sNodeMetric[];
  podsPending: number;
  podsCrashLoop: number;
  podsTotal?: number;
  podProblems?: K8sPodProblemMetric[];
  /** Dense pod list (non-Succeeded; capped by agent). */
  pods?: K8sPodMetric[];
  deploymentsTotal: number;
  deploymentsUnhealthy: number;
  deployments?: K8sDeploymentMetric[];
  /** Phase 21: publicly exposed Services (optional; older agents omit). */
  exposedServices?: K8sServiceExposureMetric[];
  /** Phase 21: NetworkPolicy coverage summary. */
  networkPolicy?: K8sNetworkPolicySummary;
};

export type K8sLatestRow = {
  agent_id: string;
  org_id: string;
  cluster_id: string;
  summary_json: string;
  collected_at: string;
  updated_at: string;
};

export type SecurityConnectionKind = "github" | "gitlab";

export type SecurityConnectionRow = {
  id: string;
  org_id: string;
  kind: SecurityConnectionKind;
  name: string;
  config_json: string;
  token_hint: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type VulnSource =
  | "trivy"
  | "osv"
  | "github"
  | "gitlab"
  | "host_posture"
  | "runtime";

export type VulnFindingRow = {
  id: string;
  org_id: string;
  source: VulnSource;
  external_id: string;
  title: string;
  severity: string;
  package_name: string | null;
  package_version: string | null;
  fixed_version: string | null;
  resource: string | null;
  cve: string | null;
  url: string | null;
  status: string;
  raw_json: string;
  agent_id: string | null;
  agent_key: string;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
};

export type LogEventRow = {
  id: string;
  org_id: string;
  agent_id: string | null;
  source: string;
  line: string;
  observed_at: string;
  matched_rules_json: string;
  severity: string | null;
  created_at: string;
};

export type QueryResult<T> = { rows: T[]; rowCount: number };

export type SqlClient = {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
  end?(): Promise<void>;
};
