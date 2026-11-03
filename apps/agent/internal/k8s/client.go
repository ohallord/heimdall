package k8s

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

type ClientsetReader struct {
	Client kubernetes.Interface
}

func DetectReader() (Reader, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		kubeconfig := firstNonEmpty(os.Getenv("KUBECONFIG"), os.Getenv("HEIMDALL_KUBECONFIG"))
		if kubeconfig == "" {
			home, _ := os.UserHomeDir()
			kubeconfig = home + "/.kube/config"
		}
		cfg, err = clientcmd.BuildConfigFromFlags("", kubeconfig)
		if err != nil {
			return nil, fmt.Errorf("kubernetes config unavailable: %w", err)
		}
	}
	// Keep API calls from blocking the metrics loop / hub ingest path.
	if cfg.Timeout == 0 {
		cfg.Timeout = 5 * time.Second
	}
	client, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	return &ClientsetReader{Client: client}, nil
}

func (r *ClientsetReader) Ping(ctx context.Context) (float64, error) {
	start := time.Now()
	_, err := r.Client.Discovery().ServerVersion()
	latency := float64(time.Since(start).Milliseconds())
	if err != nil {
		return latency, err
	}
	return latency, nil
}

func (r *ClientsetReader) ListNodes(ctx context.Context) ([]NodeHealth, error) {
	list, err := r.Client.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]NodeHealth, 0, len(list.Items))
	for _, n := range list.Items {
		ready := false
		reason := ""
		message := ""
		for _, c := range n.Status.Conditions {
			if c.Type == corev1.NodeReady {
				ready = c.Status == corev1.ConditionTrue
				reason = c.Reason
				message = c.Message
				break
			}
		}
		out = append(out, NodeHealth{
			Name:    n.Name,
			Ready:   ready,
			Reason:  reason,
			Message: message,
		})
	}
	return out, nil
}

func (r *ClientsetReader) ListPodProblems(ctx context.Context) ([]PodProblem, error) {
	list, err := r.Client.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	var out []PodProblem
	for _, p := range list.Items {
		restarts, reason, problem := classifyPodProblem(p)
		if problem == "" {
			continue
		}
		out = append(out, PodProblem{
			Namespace: p.Namespace,
			Name:      p.Name,
			Phase:     string(p.Status.Phase),
			Reason:    reason,
			Restarts:  restarts,
			Problem:   problem,
		})
	}
	return out, nil
}

func (r *ClientsetReader) ListPods(ctx context.Context) ([]PodHealth, error) {
	list, err := r.Client.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]PodHealth, 0, len(list.Items))
	for _, p := range list.Items {
		if p.Status.Phase == corev1.PodSucceeded {
			continue // skip completed Jobs by default
		}
		out = append(out, podToHealth(p))
	}
	return out, nil
}

func classifyPodProblem(p corev1.Pod) (restarts int32, reason, problem string) {
	reason = string(p.Status.Phase)
	for _, cs := range p.Status.ContainerStatuses {
		restarts += cs.RestartCount
		if cs.State.Waiting != nil {
			w := cs.State.Waiting.Reason
			if w == "CrashLoopBackOff" || w == "ImagePullBackOff" || w == "ErrImagePull" {
				return restarts, w, "crashloop"
			}
		}
	}
	if p.Status.Phase == corev1.PodPending {
		return restarts, reason, "pending"
	}
	return restarts, reason, ""
}

func podToHealth(p corev1.Pod) PodHealth {
	restarts := int32(0)
	readyN, totalN := 0, 0
	reason := ""
	containers := make([]PodContainer, 0, len(p.Status.ContainerStatuses))
	for _, cs := range p.Status.ContainerStatuses {
		totalN++
		restarts += cs.RestartCount
		if cs.Ready {
			readyN++
		}
		state, stateReason := containerState(cs)
		if stateReason != "" {
			reason = stateReason
		} else if cs.State.Terminated != nil && cs.State.Terminated.Reason != "" {
			reason = cs.State.Terminated.Reason
		}
		containers = append(containers, PodContainer{
			Name:     cs.Name,
			Image:    cs.Image,
			Ready:    cs.Ready,
			Restarts: cs.RestartCount,
			State:    state,
			Reason:   stateReason,
		})
	}
	if totalN == 0 {
		for _, c := range p.Spec.Containers {
			totalN++
			containers = append(containers, PodContainer{
				Name:  c.Name,
				Image: c.Image,
				State: "waiting",
			})
		}
	}
	if reason == "" {
		reason = string(p.Status.Phase)
	}
	phase := string(p.Status.Phase)
	healthy := phase == string(corev1.PodRunning) && readyN == totalN && totalN > 0
	if phase == string(corev1.PodSucceeded) {
		healthy = true
	}

	conditions := make([]PodCondition, 0, len(p.Status.Conditions))
	for _, c := range p.Status.Conditions {
		conditions = append(conditions, PodCondition{
			Type:    string(c.Type),
			Status:  string(c.Status),
			Reason:  c.Reason,
			Message: c.Message,
		})
	}

	resources := sumPodResources(p)

	createdAt := ""
	if !p.CreationTimestamp.IsZero() {
		createdAt = p.CreationTimestamp.UTC().Format(time.RFC3339)
	}

	return PodHealth{
		Namespace:  p.Namespace,
		Name:       p.Name,
		Phase:      phase,
		Ready:      fmt.Sprintf("%d/%d", readyN, totalN),
		Restarts:   restarts,
		Reason:     reason,
		Healthy:    healthy,
		NodeName:   p.Spec.NodeName,
		CreatedAt:  createdAt,
		Conditions: conditions,
		Containers: containers,
		Resources:  resources,
	}
}

func containerState(cs corev1.ContainerStatus) (state, reason string) {
	if cs.State.Running != nil {
		return "running", ""
	}
	if cs.State.Waiting != nil {
		return "waiting", cs.State.Waiting.Reason
	}
	if cs.State.Terminated != nil {
		return "terminated", cs.State.Terminated.Reason
	}
	return "", ""
}

func sumPodResources(p corev1.Pod) *PodResources {
	var cpuReq, cpuLim, memReq, memLim int64
	hasCPUReq, hasCPULim, hasMemReq, hasMemLim := false, false, false, false
	for _, c := range p.Spec.Containers {
		if q, ok := c.Resources.Requests[corev1.ResourceCPU]; ok {
			cpuReq += q.MilliValue()
			hasCPUReq = true
		}
		if q, ok := c.Resources.Limits[corev1.ResourceCPU]; ok {
			cpuLim += q.MilliValue()
			hasCPULim = true
		}
		if q, ok := c.Resources.Requests[corev1.ResourceMemory]; ok {
			memReq += q.Value()
			hasMemReq = true
		}
		if q, ok := c.Resources.Limits[corev1.ResourceMemory]; ok {
			memLim += q.Value()
			hasMemLim = true
		}
	}
	if !hasCPUReq && !hasCPULim && !hasMemReq && !hasMemLim {
		return nil
	}
	out := &PodResources{}
	if hasCPUReq {
		out.CPURequest = formatMilliCPU(cpuReq)
	}
	if hasCPULim {
		out.CPULimit = formatMilliCPU(cpuLim)
	}
	if hasMemReq {
		out.MemRequest = formatBytes(memReq)
	}
	if hasMemLim {
		out.MemLimit = formatBytes(memLim)
	}
	return out
}

func formatMilliCPU(milli int64) string {
	if milli%1000 == 0 {
		return fmt.Sprintf("%d", milli/1000)
	}
	return fmt.Sprintf("%dm", milli)
}

func formatBytes(b int64) string {
	const (
		ki = 1024
		mi = 1024 * 1024
		gi = 1024 * 1024 * 1024
	)
	switch {
	case b >= gi && b%gi == 0:
		return fmt.Sprintf("%dGi", b/gi)
	case b >= mi && b%mi == 0:
		return fmt.Sprintf("%dMi", b/mi)
	case b >= ki && b%ki == 0:
		return fmt.Sprintf("%dKi", b/ki)
	default:
		return fmt.Sprintf("%d", b)
	}
}

func (r *ClientsetReader) ListDeployments(ctx context.Context) ([]DeploymentHealth, error) {
	list, err := r.Client.AppsV1().Deployments("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]DeploymentHealth, 0, len(list.Items))
	for _, d := range list.Items {
		desired := int32(0)
		if d.Spec.Replicas != nil {
			desired = *d.Spec.Replicas
		}
		ready := d.Status.ReadyReplicas
		available := d.Status.AvailableReplicas
		healthy := desired == 0 || (ready >= desired && available >= desired)
		out = append(out, DeploymentHealth{
			Namespace: d.Namespace,
			Name:      d.Name,
			Desired:   desired,
			Ready:     ready,
			Available: available,
			Healthy:   healthy,
		})
	}
	return out, nil
}

func (r *ClientsetReader) ListExposedServices(ctx context.Context) ([]ServiceExposure, error) {
	list, err := r.Client.CoreV1().Services("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]ServiceExposure, 0)
	for _, svc := range list.Items {
		exp, ok := serviceToExposure(svc)
		if !ok {
			continue
		}
		out = append(out, exp)
	}
	return out, nil
}

func serviceToExposure(svc corev1.Service) (ServiceExposure, bool) {
	extIPs := append([]string{}, svc.Spec.ExternalIPs...)
	var nodePorts []int32
	for _, p := range svc.Spec.Ports {
		if p.NodePort > 0 {
			nodePorts = append(nodePorts, p.NodePort)
		}
	}
	var lbHosts []string
	for _, ing := range svc.Status.LoadBalancer.Ingress {
		if ing.Hostname != "" {
			lbHosts = append(lbHosts, ing.Hostname)
		} else if ing.IP != "" {
			lbHosts = append(lbHosts, ing.IP)
		}
	}
	typ := string(svc.Spec.Type)
	exposed := typ == string(corev1.ServiceTypeNodePort) ||
		typ == string(corev1.ServiceTypeLoadBalancer) ||
		len(extIPs) > 0
	if !exposed {
		return ServiceExposure{}, false
	}
	return ServiceExposure{
		Namespace:         svc.Namespace,
		Name:              svc.Name,
		Type:              typ,
		ExternalIPs:       extIPs,
		NodePorts:         nodePorts,
		LoadBalancerHosts: lbHosts,
	}, true
}

func (r *ClientsetReader) NetworkPolicySummary(ctx context.Context) (*NetworkPolicySummary, error) {
	nsList, err := r.Client.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	npList, err := r.Client.NetworkingV1().NetworkPolicies("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	withPolicy := map[string]struct{}{}
	for _, np := range npList.Items {
		withPolicy[np.Namespace] = struct{}{}
	}
	summary := &NetworkPolicySummary{
		NamespacesTotal: len(nsList.Items),
		WithoutPolicy:   []string{},
	}
	for _, ns := range nsList.Items {
		if _, ok := withPolicy[ns.Name]; ok {
			summary.NamespacesWithPolicy++
			continue
		}
		summary.NamespacesWithoutPolicy++
		if len(summary.WithoutPolicy) < DefaultWithoutPolicyLimit {
			summary.WithoutPolicy = append(summary.WithoutPolicy, ns.Name)
		}
	}
	return summary, nil
}

// EnrichPods attaches cluster events and best-effort log tails for unhealthy pods.
func (r *ClientsetReader) EnrichPods(ctx context.Context, pods []PodHealth) []PodHealth {
	if len(pods) == 0 {
		return pods
	}
	eventsByKey := map[string][]PodEvent{}
	if list, err := r.Client.CoreV1().Events("").List(ctx, metav1.ListOptions{
		Limit: 500,
	}); err == nil {
		for _, ev := range list.Items {
			if ev.InvolvedObject.Kind != "Pod" || ev.InvolvedObject.Name == "" {
				continue
			}
			ns := ev.InvolvedObject.Namespace
			if ns == "" {
				ns = ev.Namespace
			}
			key := ns + "/" + ev.InvolvedObject.Name
			ts := ""
			if !ev.LastTimestamp.IsZero() {
				ts = ev.LastTimestamp.UTC().Format(time.RFC3339)
			} else if !ev.EventTime.IsZero() {
				ts = ev.EventTime.UTC().Format(time.RFC3339)
			}
			eventsByKey[key] = append(eventsByKey[key], PodEvent{
				Type:          ev.Type,
				Reason:        ev.Reason,
				Message:       ev.Message,
				Count:         ev.Count,
				LastTimestamp: ts,
			})
		}
	}

	out := make([]PodHealth, len(pods))
	copy(out, pods)
	for i := range out {
		key := out[i].Namespace + "/" + out[i].Name
		if evs := eventsByKey[key]; len(evs) > 0 {
			if len(evs) > DefaultPodEventLimit {
				evs = evs[len(evs)-DefaultPodEventLimit:]
			}
			out[i].Events = evs
		}
		if out[i].Healthy {
			continue
		}
		tail, err := r.podLogTail(ctx, out[i].Namespace, out[i].Name, DefaultPodLogTailLines)
		if err == nil && strings.TrimSpace(tail) != "" {
			out[i].LogTail = tail
		}
	}
	return out
}

func (r *ClientsetReader) podLogTail(ctx context.Context, namespace, name string, tailLines int64) (string, error) {
	opts := &corev1.PodLogOptions{
		TailLines: &tailLines,
	}
	req := r.Client.CoreV1().Pods(namespace).GetLogs(name, opts)
	stream, err := req.Stream(ctx)
	if err != nil {
		return "", err
	}
	defer stream.Close()
	var buf bytes.Buffer
	_, err = io.Copy(&buf, io.LimitReader(stream, 64*1024))
	if err != nil && err != io.EOF {
		return buf.String(), err
	}
	return buf.String(), nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
