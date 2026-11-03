package k8s

import (
	"context"
	"time"
)

type NodeHealth struct {
	Name    string `json:"name"`
	Ready   bool   `json:"ready"`
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
}

type PodProblem struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Phase     string `json:"phase"`
	Reason    string `json:"reason,omitempty"`
	Restarts  int32  `json:"restarts"`
	Problem   string `json:"problem"` // pending | crashloop
}

type PodCondition struct {
	Type    string `json:"type"`
	Status  string `json:"status"`
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
}

type PodContainer struct {
	Name     string `json:"name"`
	Image    string `json:"image,omitempty"`
	Ready    bool   `json:"ready"`
	Restarts int32  `json:"restarts"`
	State    string `json:"state,omitempty"` // running | waiting | terminated
	Reason   string `json:"reason,omitempty"`
}

type PodResources struct {
	CPURequest string `json:"cpuRequest,omitempty"`
	CPULimit   string `json:"cpuLimit,omitempty"`
	MemRequest string `json:"memRequest,omitempty"`
	MemLimit   string `json:"memLimit,omitempty"`
}

type PodEvent struct {
	Type          string `json:"type,omitempty"`
	Reason        string `json:"reason,omitempty"`
	Message       string `json:"message,omitempty"`
	Count         int32  `json:"count,omitempty"`
	LastTimestamp string `json:"lastTimestamp,omitempty"`
}

// PodHealth is a dense row for Fleet / host K8s tables (+ optional detail fields).
type PodHealth struct {
	Namespace  string         `json:"namespace"`
	Name       string         `json:"name"`
	Phase      string         `json:"phase"`
	Ready      string         `json:"ready"` // e.g. "1/1"
	Restarts   int32          `json:"restarts"`
	Reason     string         `json:"reason,omitempty"`
	Healthy    bool           `json:"healthy"`
	NodeName   string         `json:"nodeName,omitempty"`
	CreatedAt  string         `json:"createdAt,omitempty"`
	Conditions []PodCondition `json:"conditions,omitempty"`
	Containers []PodContainer `json:"containers,omitempty"`
	Resources  *PodResources  `json:"resources,omitempty"`
	Events     []PodEvent     `json:"events,omitempty"`
	LogTail    string         `json:"logTail,omitempty"`
}

type DeploymentHealth struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Desired   int32  `json:"desired"`
	Ready     int32  `json:"ready"`
	Available int32  `json:"available"`
	Healthy   bool   `json:"healthy"`
}

// ServiceExposure is a NodePort / LoadBalancer / ExternalIP Service.
type ServiceExposure struct {
	Namespace         string   `json:"namespace"`
	Name              string   `json:"name"`
	Type              string   `json:"type"`
	ExternalIPs       []string `json:"externalIPs,omitempty"`
	NodePorts         []int32  `json:"nodePorts,omitempty"`
	LoadBalancerHosts []string `json:"loadBalancerHosts,omitempty"`
}

// NetworkPolicySummary counts namespaces with vs without any NetworkPolicy.
type NetworkPolicySummary struct {
	NamespacesTotal         int      `json:"namespacesTotal"`
	NamespacesWithPolicy    int      `json:"namespacesWithPolicy"`
	NamespacesWithoutPolicy int      `json:"namespacesWithoutPolicy"`
	WithoutPolicy           []string `json:"withoutPolicy,omitempty"`
}

// DefaultPodListLimit caps pods in the metrics payload (Succeeded excluded by default).
const DefaultPodListLimit = 80

// DefaultPodEventLimit caps events attached per pod.
const DefaultPodEventLimit = 8

// DefaultPodLogTailLines caps log lines for unhealthy pods.
const DefaultPodLogTailLines = int64(50)

// DefaultExposedServiceLimit caps exposed Services in the metrics payload.
const DefaultExposedServiceLimit = 40

// DefaultWithoutPolicyLimit caps namespaces listed without NetworkPolicy.
const DefaultWithoutPolicyLimit = 30

type Sample struct {
	CollectedAt          time.Time             `json:"collectedAt"`
	ClusterID            string                `json:"clusterId"`
	APIServerReachable   bool                  `json:"apiServerReachable"`
	APIServerLatencyMs   float64               `json:"apiServerLatencyMs"`
	APIServerError       string                `json:"apiServerError,omitempty"`
	NodesTotal           int                   `json:"nodesTotal"`
	NodesReady           int                   `json:"nodesReady"`
	NodesNotReady        []NodeHealth          `json:"nodesNotReady"`
	PodsPending          int                   `json:"podsPending"`
	PodsCrashLoop        int                   `json:"podsCrashLoop"`
	PodsTotal            int                   `json:"podsTotal"`
	PodProblems          []PodProblem          `json:"podProblems"`
	Pods                 []PodHealth           `json:"pods"`
	DeploymentsTotal     int                   `json:"deploymentsTotal"`
	DeploymentsUnhealthy int                   `json:"deploymentsUnhealthy"`
	Deployments          []DeploymentHealth    `json:"deployments"`
	ExposedServices      []ServiceExposure     `json:"exposedServices,omitempty"`
	NetworkPolicy        *NetworkPolicySummary `json:"networkPolicy,omitempty"`
}

// Reader abstracts Kubernetes reads for fake client-go / tests.
type Reader interface {
	Ping(ctx context.Context) (latencyMs float64, err error)
	ListNodes(ctx context.Context) ([]NodeHealth, error)
	ListPodProblems(ctx context.Context) ([]PodProblem, error)
	ListPods(ctx context.Context) ([]PodHealth, error)
	ListDeployments(ctx context.Context) ([]DeploymentHealth, error)
	ListExposedServices(ctx context.Context) ([]ServiceExposure, error)
	NetworkPolicySummary(ctx context.Context) (*NetworkPolicySummary, error)
}

// PodDetailEnricher optionally attaches events + log tails after ListPods.
type PodDetailEnricher interface {
	EnrichPods(ctx context.Context, pods []PodHealth) []PodHealth
}
