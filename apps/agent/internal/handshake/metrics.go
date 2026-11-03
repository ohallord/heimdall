package handshake

import "encoding/json"

type MountMetric struct {
	Path        string  `json:"path"`
	Present     bool    `json:"present"`
	FSType      string  `json:"fsType,omitempty"`
	Device      string  `json:"device,omitempty"`
	TotalBytes  int64   `json:"totalBytes,omitempty"`
	UsedBytes   int64   `json:"usedBytes,omitempty"`
	UsedPercent float64 `json:"usedPercent,omitempty"`
}

type DiskMetric struct {
	MountPoint  string  `json:"mountPoint"`
	Device      string  `json:"device"`
	TotalBytes  int64   `json:"totalBytes"`
	UsedBytes   int64   `json:"usedBytes"`
	FreeBytes   int64   `json:"freeBytes"`
	UsedPercent float64 `json:"usedPercent"`
}

type ContainerMetric struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Image         string   `json:"image"`
	State         string   `json:"state"`
	Status        string   `json:"status"`
	RestartCount  int      `json:"restartCount"`
	ExitCode      *int     `json:"exitCode,omitempty"`
	OOMKilled     bool     `json:"oomKilled"`
	RestartLoop   bool     `json:"restartLoop"`
	CPUPercent    *float64 `json:"cpuPercent,omitempty"`
	MemUsageBytes *int64   `json:"memUsageBytes,omitempty"`
	MemLimitBytes *int64   `json:"memLimitBytes,omitempty"`
	MemPercent    *float64 `json:"memPercent,omitempty"`
	StartedAt     string   `json:"startedAt,omitempty"`
	FinishedAt    string   `json:"finishedAt,omitempty"`
}

type K8sNodeMetric struct {
	Name    string `json:"name"`
	Ready   bool   `json:"ready"`
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
}

type K8sPodProblemMetric struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Phase     string `json:"phase"`
	Reason    string `json:"reason,omitempty"`
	Restarts  int32  `json:"restarts"`
	Problem   string `json:"problem"`
}

type K8sPodConditionMetric struct {
	Type    string `json:"type"`
	Status  string `json:"status"`
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
}

type K8sPodContainerMetric struct {
	Name     string `json:"name"`
	Image    string `json:"image,omitempty"`
	Ready    bool   `json:"ready"`
	Restarts int32  `json:"restarts"`
	State    string `json:"state,omitempty"`
	Reason   string `json:"reason,omitempty"`
}

type K8sPodResourcesMetric struct {
	CPURequest string `json:"cpuRequest,omitempty"`
	CPULimit   string `json:"cpuLimit,omitempty"`
	MemRequest string `json:"memRequest,omitempty"`
	MemLimit   string `json:"memLimit,omitempty"`
}

type K8sPodEventMetric struct {
	Type          string `json:"type,omitempty"`
	Reason        string `json:"reason,omitempty"`
	Message       string `json:"message,omitempty"`
	Count         int32  `json:"count,omitempty"`
	LastTimestamp string `json:"lastTimestamp,omitempty"`
}

type K8sPodMetric struct {
	Namespace  string                   `json:"namespace"`
	Name       string                   `json:"name"`
	Phase      string                   `json:"phase"`
	Ready      string                   `json:"ready"`
	Restarts   int32                    `json:"restarts"`
	Reason     string                   `json:"reason,omitempty"`
	Healthy    bool                     `json:"healthy"`
	NodeName   string                   `json:"nodeName,omitempty"`
	CreatedAt  string                   `json:"createdAt,omitempty"`
	Conditions []K8sPodConditionMetric  `json:"conditions,omitempty"`
	Containers []K8sPodContainerMetric  `json:"containers,omitempty"`
	Resources  *K8sPodResourcesMetric   `json:"resources,omitempty"`
	Events     []K8sPodEventMetric      `json:"events,omitempty"`
	LogTail    string                   `json:"logTail,omitempty"`
}

type K8sDeploymentMetric struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Desired   int32  `json:"desired"`
	Ready     int32  `json:"ready"`
	Available int32  `json:"available"`
	Healthy   bool   `json:"healthy"`
}

type K8sServiceExposureMetric struct {
	Namespace         string   `json:"namespace"`
	Name              string   `json:"name"`
	Type              string   `json:"type"`
	ExternalIPs       []string `json:"externalIPs,omitempty"`
	NodePorts         []int32  `json:"nodePorts,omitempty"`
	LoadBalancerHosts []string `json:"loadBalancerHosts,omitempty"`
}

type K8sNetworkPolicySummary struct {
	NamespacesTotal         int      `json:"namespacesTotal"`
	NamespacesWithPolicy    int      `json:"namespacesWithPolicy"`
	NamespacesWithoutPolicy int      `json:"namespacesWithoutPolicy"`
	WithoutPolicy           []string `json:"withoutPolicy,omitempty"`
}

type K8sClusterMetric struct {
	Enabled              bool                      `json:"enabled"`
	ClusterID            string                    `json:"clusterId"`
	APIServerReachable   bool                      `json:"apiServerReachable"`
	APIServerLatencyMs   float64                   `json:"apiServerLatencyMs"`
	APIServerError       string                    `json:"apiServerError,omitempty"`
	NodesTotal           int                       `json:"nodesTotal"`
	NodesReady           int                       `json:"nodesReady"`
	NodesNotReady        []K8sNodeMetric           `json:"nodesNotReady"`
	PodsPending          int                       `json:"podsPending"`
	PodsCrashLoop        int                       `json:"podsCrashLoop"`
	PodsTotal            int                       `json:"podsTotal"`
	PodProblems          []K8sPodProblemMetric     `json:"podProblems"`
	Pods                 []K8sPodMetric            `json:"pods"`
	DeploymentsTotal     int                       `json:"deploymentsTotal"`
	DeploymentsUnhealthy int                       `json:"deploymentsUnhealthy"`
	Deployments          []K8sDeploymentMetric     `json:"deployments"`
	ExposedServices      []K8sServiceExposureMetric `json:"exposedServices,omitempty"`
	NetworkPolicy        *K8sNetworkPolicySummary  `json:"networkPolicy,omitempty"`
}

type MetricsPayload struct {
	AgentID          string            `json:"agentId"`
	ClusterID        string            `json:"clusterId,omitempty"`
	CollectedAt      string            `json:"collectedAt"`
	CPUPercent       float64           `json:"cpuPercent"`
	MemPercent       float64           `json:"memPercent"`
	MemUsedBytes     int64             `json:"memUsedBytes"`
	MemTotalBytes    int64             `json:"memTotalBytes"`
	Load1            float64           `json:"load1"`
	Load5            float64           `json:"load5"`
	Load15           float64           `json:"load15"`
	Disks            []DiskMetric      `json:"disks"`
	Mounts           []MountMetric     `json:"mounts"`
	ContainerRuntime string            `json:"containerRuntime,omitempty"`
	Containers       []ContainerMetric `json:"containers,omitempty"`
	K8sEnabled       bool              `json:"k8sEnabled"`
	Kubernetes       *K8sClusterMetric `json:"kubernetes,omitempty"`
}

type MetricsResponse struct {
	Accepted   bool   `json:"accepted"`
	AgentID    string `json:"agentId"`
	LastSeenAt string `json:"lastSeenAt"`
	AlertsFired int   `json:"alertsFired"`
}

func (c *Client) IngestMetrics(payload MetricsPayload) (MetricsResponse, error) {
	var out MetricsResponse
	if err := c.postJSON("/api/v1/agents/metrics", payload, &out, 202, 200); err != nil {
		return MetricsResponse{}, err
	}
	return out, nil
}

type VulnsIngestPayload struct {
	AgentID     string          `json:"agentId"`
	TrivyReport json.RawMessage `json:"trivyReport,omitempty"`
	OsvReport   json.RawMessage `json:"osvReport,omitempty"`
	// ScanKind is "image" (default) or "host_posture".
	ScanKind string `json:"scanKind,omitempty"`
}

type VulnsIngestResponse struct {
	Accepted bool           `json:"accepted"`
	AgentID  string         `json:"agentId"`
	Written  int            `json:"written"`
	BySource map[string]int `json:"bySource"`
}

func (c *Client) IngestVulns(agentID string, trivyReport json.RawMessage) error {
	return c.IngestVulnsScan(agentID, trivyReport, "image")
}

func (c *Client) IngestVulnsScan(agentID string, trivyReport json.RawMessage, scanKind string) error {
	var out VulnsIngestResponse
	payload := VulnsIngestPayload{
		AgentID:     agentID,
		TrivyReport: trivyReport,
		ScanKind:    scanKind,
	}
	if err := c.postJSON("/api/v1/agents/vulns", payload, &out, 202, 200); err != nil {
		return err
	}
	return nil
}

type LogLinePayload struct {
	Source     string `json:"source"`
	Line       string `json:"line"`
	ObservedAt string `json:"observedAt,omitempty"`
}

type LogsIngestPayload struct {
	AgentID string           `json:"agentId"`
	Lines   []LogLinePayload `json:"lines"`
}

type LogsIngestResponse struct {
	Accepted    bool `json:"accepted"`
	Lines       int  `json:"lines"`
	Matches     int  `json:"matches"`
	AlertsFired int  `json:"alertsFired"`
}

func (c *Client) IngestLogs(agentID string, lines []LogLinePayload) (LogsIngestResponse, error) {
	var out LogsIngestResponse
	payload := LogsIngestPayload{AgentID: agentID, Lines: lines}
	if err := c.postJSON("/api/v1/agents/logs", payload, &out, 202, 200); err != nil {
		return LogsIngestResponse{}, err
	}
	return out, nil
}
