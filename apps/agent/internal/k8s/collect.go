package k8s

import (
	"context"
	"time"
)

type Options struct {
	Reader    Reader
	ClusterID string
	Timeout   time.Duration
}

func Collect(opts Options) (Sample, error) {
	sample := Sample{
		CollectedAt:   time.Now().UTC(),
		ClusterID:     opts.ClusterID,
		NodesNotReady: []NodeHealth{},
		PodProblems:   []PodProblem{},
		Pods:          []PodHealth{},
		Deployments:   []DeploymentHealth{},
	}
	if sample.ClusterID == "" {
		sample.ClusterID = "default"
	}
	if opts.Reader == nil {
		sample.APIServerReachable = false
		sample.APIServerError = "no kubernetes client configured"
		return sample, nil
	}

	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = 8 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	latency, err := opts.Reader.Ping(ctx)
	if err != nil {
		sample.APIServerReachable = false
		sample.APIServerError = err.Error()
		sample.APIServerLatencyMs = latency
		return sample, nil
	}
	sample.APIServerReachable = true
	sample.APIServerLatencyMs = latency

	nodes, err := opts.Reader.ListNodes(ctx)
	if err != nil {
		sample.APIServerError = err.Error()
		return sample, nil
	}
	sample.NodesTotal = len(nodes)
	for _, n := range nodes {
		if n.Ready {
			sample.NodesReady++
		} else {
			sample.NodesNotReady = append(sample.NodesNotReady, n)
		}
	}

	problems, err := opts.Reader.ListPodProblems(ctx)
	if err != nil {
		sample.APIServerError = err.Error()
		return sample, nil
	}
	sample.PodProblems = problems
	for _, p := range problems {
		switch p.Problem {
		case "pending":
			sample.PodsPending++
		case "crashloop":
			sample.PodsCrashLoop++
		}
	}

	pods, err := opts.Reader.ListPods(ctx)
	if err != nil {
		sample.APIServerError = err.Error()
		return sample, nil
	}
	sample.PodsTotal = len(pods)
	limit := DefaultPodListLimit
	if len(pods) > limit {
		// Prefer unhealthy rows, then fill with the rest up to the cap.
		var bad, ok []PodHealth
		for _, p := range pods {
			if p.Healthy {
				ok = append(ok, p)
			} else {
				bad = append(bad, p)
			}
		}
		trimmed := append([]PodHealth{}, bad...)
		for _, p := range ok {
			if len(trimmed) >= limit {
				break
			}
			trimmed = append(trimmed, p)
		}
		pods = trimmed
	}
	if enricher, ok := opts.Reader.(PodDetailEnricher); ok {
		pods = enricher.EnrichPods(ctx, pods)
	}
	sample.Pods = pods

	deps, err := opts.Reader.ListDeployments(ctx)
	if err != nil {
		sample.APIServerError = err.Error()
		return sample, nil
	}
	sample.Deployments = deps
	sample.DeploymentsTotal = len(deps)
	for _, d := range deps {
		if !d.Healthy {
			sample.DeploymentsUnhealthy++
		}
	}

	// Soft-fail exposure / NetworkPolicy so older RBAC does not blank the rest.
	if services, serr := opts.Reader.ListExposedServices(ctx); serr == nil {
		if len(services) > DefaultExposedServiceLimit {
			services = services[:DefaultExposedServiceLimit]
		}
		sample.ExposedServices = services
	}
	if np, nerr := opts.Reader.NetworkPolicySummary(ctx); nerr == nil {
		sample.NetworkPolicy = np
	}
	return sample, nil
}
