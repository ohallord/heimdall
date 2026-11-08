package main

import (
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/heimdall-ops/heimdall/apps/agent/internal/collect"
	"github.com/heimdall-ops/heimdall/apps/agent/internal/config"
	"github.com/heimdall-ops/heimdall/apps/agent/internal/containers"
	"github.com/heimdall-ops/heimdall/apps/agent/internal/handshake"
	"github.com/heimdall-ops/heimdall/apps/agent/internal/k8s"
	"github.com/heimdall-ops/heimdall/apps/agent/internal/logs"
	"github.com/heimdall-ops/heimdall/apps/agent/internal/state"
	"github.com/heimdall-ops/heimdall/apps/agent/internal/vulns"
)

var k8sUnavailableOnce sync.Once

// containerWarn keeps a missing/unreadable container socket from logging every interval.
var containerWarn containers.SkipWarner

// version is overridden at build time: -ldflags "-X main.version=<ver>" (scripts/build-dist.sh).
var version = "0.7.0-phase7"

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(2)
	}

	switch os.Args[1] {
	case "register":
		runRegister(os.Args[2:])
	case "run":
		runLoop(os.Args[2:])
	case "collect":
		runCollectOnce(os.Args[2:])
	case "scan-image":
		runScanImage(os.Args[2:])
	case "scan-host":
		runScanHost(os.Args[2:])
	case "watch-logs":
		runWatchLogs(os.Args[2:])
	case "version":
		fmt.Println(version)
	case "help", "-h", "--help":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", os.Args[1])
		printUsage()
		os.Exit(2)
	}
}

func loadConfig(args []string) config.Config {
	fs := flag.NewFlagSet("agent", flag.ExitOnError)
	hubURL := fs.String("hub", "", "Heimdall hub base URL (or HEIMDALL_HUB_URL)")
	token := fs.String("token", "", "Bootstrap/agent token (or HEIMDALL_BOOTSTRAP_TOKEN)")
	hostname := fs.String("hostname", "", "Agent hostname (defaults to OS hostname)")
	interval := fs.Duration("interval", 0, "Sample interval (or HEIMDALL_INTERVAL)")
	watch := fs.String("watch-mounts", "", "Comma-separated mounts to watch")
	logPaths := fs.String("log-paths", "", "Comma-separated log files to tail (HEIMDALL_LOG_PATHS)")
	clusterID := fs.String("cluster-id", "", "Cluster id for multi-cluster reserve (HEIMDALL_CLUSTER_ID)")
	// Empty = defer to HEIMDALL_ENABLE_K8S / default false (do not force true).
	enableK8sFlag := fs.String("enable-k8s", "", "Collect Kubernetes health (true/false). Empty uses HEIMDALL_ENABLE_K8S (default false)")
	_ = fs.Parse(args)

	cfg, err := config.Load(config.Overrides{
		HubURL:      *hubURL,
		Token:       *token,
		Hostname:    *hostname,
		Version:     version,
		Interval:    *interval,
		WatchMounts: *watch,
		LogPaths:    *logPaths,
		ClusterID:   *clusterID,
		EnableK8s:   parseOptionalBoolFlag(*enableK8sFlag),
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "config error: %v\n", err)
		os.Exit(1)
	}
	logConfigWarnings(cfg)
	return cfg
}

// logConfigWarnings prints non-fatal config notes (e.g. a plain-http hub URL).
func logConfigWarnings(cfg config.Config) {
	for _, w := range cfg.Warnings {
		fmt.Fprintf(os.Stderr, "warning: %s\n", w)
	}
}

// newClient builds a hub client backed by the persistent per-agent secret store.
// A store that cannot be read is fatal: registering without the stored secret would 409.
func newClient(cfg config.Config) *handshake.Client {
	client := handshake.NewClient(cfg.HubURL, cfg.Token)
	if err := client.UseSecretStore(state.NewStore(state.Dir())); err != nil {
		fmt.Fprintf(os.Stderr, "state error: %v\n", err)
		os.Exit(1)
	}
	return client
}

// retryRegisterOn401 re-registers (presenting the stored secret) after an auth failure,
// e.g. the hub was restored from backup or an admin re-enrolled this host. Nothing is cleared.
func retryRegisterOn401(client *handshake.Client, cfg config.Config, err error) {
	if err == nil || !strings.Contains(err.Error(), "status 401") {
		return
	}
	fmt.Fprintln(os.Stderr, "ingest unauthorized; re-registering")
	if _, rerr := client.Register(handshake.RegisterRequest{Token: cfg.Token, Hostname: cfg.Hostname, Version: cfg.Version}); rerr != nil {
		fmt.Fprintf(os.Stderr, "re-register failed: %v\n", rerr)
	}
}

func runRegister(args []string) {
	cfg := loadConfig(args)
	client := newClient(cfg)
	result, err := client.Register(handshake.RegisterRequest{
		Token:    cfg.Token,
		Hostname: cfg.Hostname,
		Version:  cfg.Version,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "register failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("registered agent %s as %s cluster=%s\n", result.AgentID, result.Hostname, cfg.ClusterID)

	if err := pushSample(client, result.AgentID, cfg); err != nil {
		fmt.Fprintf(os.Stderr, "metrics ingest failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("metrics ingest ok")
}

func runLoop(args []string) {
	cfg := loadConfig(args)
	client := newClient(cfg)

	result, err := client.Register(handshake.RegisterRequest{
		Token:    cfg.Token,
		Hostname: cfg.Hostname,
		Version:  cfg.Version,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "register failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("running agent %s hostname=%s cluster=%s interval=%s k8s=%v logs=%d\n",
		result.AgentID, result.Hostname, cfg.ClusterID, cfg.Interval, cfg.EnableK8s, len(cfg.LogPaths))

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	ticker := time.NewTicker(cfg.Interval)
	defer ticker.Stop()

	logOffsets := map[string]int64{}
	hostPostureEnabled := envTruthy("HEIMDALL_HOST_POSTURE")
	var postureTicker *time.Ticker
	if hostPostureEnabled {
		postureTicker = time.NewTicker(hostPostureInterval())
		defer postureTicker.Stop()
		fmt.Printf("host posture enabled interval=%s root=%s\n",
			hostPostureInterval(), vulns.ResolveHostRoot())
		if err := pushHostPosture(client, result.AgentID); err != nil {
			fmt.Fprintf(os.Stderr, "initial host posture scan skipped: %v\n", err)
		}
	}

	if err := pushSample(client, result.AgentID, cfg); err != nil {
		fmt.Fprintf(os.Stderr, "initial metrics failed: %v\n", err)
	}
	if err := pushLogs(client, result.AgentID, cfg, logOffsets); err != nil {
		fmt.Fprintf(os.Stderr, "initial log ingest failed: %v\n", err)
	}

	for {
		select {
		case <-stop:
			fmt.Println("shutting down")
			return
		case <-ticker.C:
			if err := pushSample(client, result.AgentID, cfg); err != nil {
				fmt.Fprintf(os.Stderr, "metrics ingest failed: %v\n", err)
				retryRegisterOn401(client, cfg, err)
			}
			if err := pushLogs(client, result.AgentID, cfg, logOffsets); err != nil {
				fmt.Fprintf(os.Stderr, "log ingest failed: %v\n", err)
			}
		case <-postureChan(postureTicker):
			if err := pushHostPosture(client, result.AgentID); err != nil {
				fmt.Fprintf(os.Stderr, "host posture scan skipped: %v\n", err)
			}
		}
	}
}

func postureChan(t *time.Ticker) <-chan time.Time {
	if t == nil {
		return nil
	}
	return t.C
}

func envTruthy(key string) bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	return v == "1" || v == "true" || v == "yes" || v == "on"
}

func hostPostureInterval() time.Duration {
	raw := strings.TrimSpace(os.Getenv("HEIMDALL_HOST_POSTURE_INTERVAL"))
	if raw == "" {
		return 24 * time.Hour
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		return 24 * time.Hour
	}
	return d
}

func pushHostPosture(client *handshake.Client, agentID string) error {
	timeout := 10 * time.Minute
	if raw := strings.TrimSpace(os.Getenv("HEIMDALL_TRIVY_TIMEOUT")); raw != "" {
		if d, err := time.ParseDuration(raw); err == nil && d > 0 {
			timeout = d
		}
	}
	report, err := vulns.ScanRootfs(vulns.ResolveHostRoot(), timeout)
	if err != nil {
		return err
	}
	return client.IngestVulnsScan(agentID, report, "host_posture")
}

func runCollectOnce(args []string) {
	cfg := loadConfig(args)
	sample, err := collect.Collect(collect.Options{WatchMounts: cfg.WatchMounts})
	if err != nil {
		fmt.Fprintf(os.Stderr, "collect failed: %v\n", err)
		os.Exit(1)
	}
	ctrSample, err := containers.Collect(containers.DetectRuntime())
	if err != nil {
		fmt.Fprintf(os.Stderr, "container collect warning: %v\n", err)
		ctrSample.Runtime = "error"
	}
	k8sInfo := "disabled"
	if cfg.EnableK8s {
		reader, rerr := k8s.DetectReader()
		if rerr != nil {
			k8sInfo = "unavailable"
		} else {
			ks, kerr := k8s.Collect(k8s.Options{Reader: reader, ClusterID: cfg.ClusterID})
			if kerr != nil {
				k8sInfo = "error"
			} else {
				k8sInfo = fmt.Sprintf("reachable=%v nodes=%d/%d pending=%d crash=%d unhealthyDeps=%d",
					ks.APIServerReachable, ks.NodesReady, ks.NodesTotal, ks.PodsPending, ks.PodsCrashLoop, ks.DeploymentsUnhealthy)
			}
		}
	}
	fmt.Printf("cpu=%.1f%% mem=%.1f%% load1=%.2f mounts=%d disks=%d containers=%d runtime=%s k8s=[%s]\n",
		sample.CPUPercent, sample.MemPercent, sample.Load1, len(sample.Mounts), len(sample.Disks),
		len(ctrSample.Containers), ctrSample.Runtime, k8sInfo)
}

func runWatchLogs(args []string) {
	cfg := loadConfig(args)
	if len(cfg.LogPaths) == 0 {
		fmt.Fprintln(os.Stderr, "set --log-paths or HEIMDALL_LOG_PATHS")
		os.Exit(2)
	}
	client := newClient(cfg)
	result, err := client.Register(handshake.RegisterRequest{
		Token:    cfg.Token,
		Hostname: cfg.Hostname,
		Version:  cfg.Version,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "register failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("watching logs for agent %s paths=%v\n", result.AgentID, cfg.LogPaths)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	ticker := time.NewTicker(cfg.Interval)
	defer ticker.Stop()
	offsets := map[string]int64{}

	if err := pushLogs(client, result.AgentID, cfg, offsets); err != nil {
		fmt.Fprintf(os.Stderr, "initial log ingest failed: %v\n", err)
	}
	for {
		select {
		case <-stop:
			fmt.Println("shutting down")
			return
		case <-ticker.C:
			if err := pushLogs(client, result.AgentID, cfg, offsets); err != nil {
				fmt.Fprintf(os.Stderr, "log ingest failed: %v\n", err)
			}
		}
	}
}

func pushLogs(client *handshake.Client, agentID string, cfg config.Config, offsets map[string]int64) error {
	if len(cfg.LogPaths) == 0 {
		return nil
	}
	var batch []handshake.LogLinePayload
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, path := range cfg.LogPaths {
		off := offsets[path]
		lines, next, err := logs.ReadNewLines(path, off, 200)
		if err != nil {
			fmt.Fprintf(os.Stderr, "tail %s: %v\n", path, err)
			continue
		}
		offsets[path] = next
		for _, line := range lines {
			batch = append(batch, handshake.LogLinePayload{
				Source:     line.Source,
				Line:       line.Text,
				ObservedAt: now,
			})
		}
	}
	if len(batch) == 0 {
		return nil
	}
	res, err := client.IngestLogs(agentID, batch)
	if err != nil {
		return err
	}
	if res.Matches > 0 {
		fmt.Printf("log ingest lines=%d matches=%d alerts=%d\n", res.Lines, res.Matches, res.AlertsFired)
	}
	return nil
}

func runScanImage(args []string) {
	fs := flag.NewFlagSet("scan-image", flag.ExitOnError)
	hubURL := fs.String("hub", "", "Heimdall hub base URL")
	token := fs.String("token", "", "Bootstrap/agent token")
	hostname := fs.String("hostname", "", "Agent hostname")
	image := fs.String("image", "", "Container image to scan with Trivy")
	_ = fs.Parse(args)

	cfg, err := config.Load(config.Overrides{
		HubURL:   *hubURL,
		Token:    *token,
		Hostname: *hostname,
		Version:  version,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "config error: %v\n", err)
		os.Exit(1)
	}
	logConfigWarnings(cfg)
	if *image == "" {
		fmt.Fprintln(os.Stderr, "--image is required")
		os.Exit(2)
	}

	report, err := vulns.ScanImage(*image, 0)
	if err != nil {
		fmt.Fprintf(os.Stderr, "trivy scan failed: %v\n", err)
		os.Exit(1)
	}

	client := newClient(cfg)
	reg, err := client.Register(handshake.RegisterRequest{
		Token:    cfg.Token,
		Hostname: cfg.Hostname,
		Version:  cfg.Version,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "register failed: %v\n", err)
		os.Exit(1)
	}
	if err := client.IngestVulns(reg.AgentID, report); err != nil {
		fmt.Fprintf(os.Stderr, "vuln ingest failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("trivy scan ingested for %s agent=%s\n", *image, reg.AgentID)
}

func runScanHost(args []string) {
	fs := flag.NewFlagSet("scan-host", flag.ExitOnError)
	hubURL := fs.String("hub", "", "Heimdall hub base URL")
	token := fs.String("token", "", "Bootstrap/agent token")
	hostname := fs.String("hostname", "", "Agent hostname")
	root := fs.String("root", "", "Host root path (or HEIMDALL_HOST_ROOT)")
	_ = fs.Parse(args)

	cfg, err := config.Load(config.Overrides{
		HubURL:   *hubURL,
		Token:    *token,
		Hostname: *hostname,
		Version:  version,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "config error: %v\n", err)
		os.Exit(1)
	}
	logConfigWarnings(cfg)

	scanRoot := strings.TrimSpace(*root)
	if scanRoot == "" {
		scanRoot = vulns.ResolveHostRoot()
	}
	timeout := 10 * time.Minute
	if raw := strings.TrimSpace(os.Getenv("HEIMDALL_TRIVY_TIMEOUT")); raw != "" {
		if d, err := time.ParseDuration(raw); err == nil && d > 0 {
			timeout = d
		}
	}

	report, err := vulns.ScanRootfs(scanRoot, timeout)
	if err != nil {
		fmt.Fprintf(os.Stderr, "trivy rootfs scan failed: %v\n", err)
		os.Exit(1)
	}

	client := newClient(cfg)
	reg, err := client.Register(handshake.RegisterRequest{
		Token:    cfg.Token,
		Hostname: cfg.Hostname,
		Version:  cfg.Version,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "register failed: %v\n", err)
		os.Exit(1)
	}
	if err := client.IngestVulnsScan(reg.AgentID, report, "host_posture"); err != nil {
		fmt.Fprintf(os.Stderr, "vuln ingest failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("host posture scan ingested root=%s agent=%s\n", scanRoot, reg.AgentID)
}

func pushSample(client *handshake.Client, agentID string, cfg config.Config) error {
	sample, err := collect.Collect(collect.Options{WatchMounts: cfg.WatchMounts})
	if err != nil {
		return err
	}
	payload := handshake.MetricsPayload{
		AgentID:       agentID,
		ClusterID:     cfg.ClusterID,
		CollectedAt:   sample.CollectedAt.Format(time.RFC3339Nano),
		CPUPercent:    sample.CPUPercent,
		MemPercent:    sample.MemPercent,
		MemUsedBytes:  sample.MemUsedBytes,
		MemTotalBytes: sample.MemTotalBytes,
		Load1:         sample.Load1,
		Load5:         sample.Load5,
		Load15:        sample.Load15,
	}
	for _, d := range sample.Disks {
		payload.Disks = append(payload.Disks, handshake.DiskMetric{
			MountPoint:  d.MountPoint,
			Device:      d.Device,
			TotalBytes:  d.TotalBytes,
			UsedBytes:   d.UsedBytes,
			FreeBytes:   d.FreeBytes,
			UsedPercent: d.UsedPercent,
		})
	}
	for _, m := range sample.Mounts {
		payload.Mounts = append(payload.Mounts, handshake.MountMetric{
			Path:        m.Path,
			Present:     m.Present,
			FSType:      m.FSType,
			Device:      m.Device,
			TotalBytes:  m.TotalBytes,
			UsedBytes:   m.UsedBytes,
			UsedPercent: m.UsedPercent,
		})
	}

	ctrSample, err := containers.Collect(containers.DetectRuntime())
	if msg, ok := containerWarn.Check(err); ok {
		fmt.Fprintln(os.Stderr, msg)
	}
	if err != nil {
		payload.ContainerRuntime = "error"
	} else {
		payload.ContainerRuntime = ctrSample.Runtime
		for _, c := range ctrSample.Containers {
			payload.Containers = append(payload.Containers, handshake.ContainerMetric{
				ID:            c.ID,
				Name:          c.Name,
				Image:         c.Image,
				State:         c.State,
				Status:        c.Status,
				RestartCount:  c.RestartCount,
				ExitCode:      c.ExitCode,
				OOMKilled:     c.OOMKilled,
				RestartLoop:   c.RestartLoop,
				CPUPercent:    c.CPUPercent,
				MemUsageBytes: c.MemUsageBytes,
				MemLimitBytes: c.MemLimitBytes,
				MemPercent:    c.MemPercent,
				StartedAt:     c.StartedAt,
				FinishedAt:    c.FinishedAt,
			})
		}
	}

	payload.K8sEnabled = cfg.EnableK8s
	if !cfg.EnableK8s {
		// Explicit disabled sample so the hub never treats an empty/stale row as API down.
		payload.Kubernetes = &handshake.K8sClusterMetric{
			Enabled:            false,
			ClusterID:          cfg.ClusterID,
			APIServerReachable: false,
		}
	} else {
		reader, rerr := k8s.DetectReader()
		if rerr != nil {
			k8sUnavailableOnce.Do(func() {
				fmt.Fprintf(os.Stderr, "k8s enabled but config unavailable: %v\n", rerr)
			})
			payload.Kubernetes = &handshake.K8sClusterMetric{
				Enabled:            true,
				ClusterID:          cfg.ClusterID,
				APIServerReachable: false,
				APIServerError:     rerr.Error(),
			}
		} else if ks, kerr := k8s.Collect(k8s.Options{
			Reader:    reader,
			ClusterID: cfg.ClusterID,
			Timeout:   5 * time.Second,
		}); kerr != nil {
			k8sUnavailableOnce.Do(func() {
				fmt.Fprintf(os.Stderr, "k8s collect failed; will retry quietly: %v\n", kerr)
			})
			payload.Kubernetes = &handshake.K8sClusterMetric{
				Enabled:            true,
				ClusterID:          cfg.ClusterID,
				APIServerReachable: false,
				APIServerError:     kerr.Error(),
			}
		} else {
			payload.Kubernetes = toK8sMetric(ks)
		}
	}

	_, err = client.IngestMetrics(payload)
	return err
}

func toK8sMetric(ks k8s.Sample) *handshake.K8sClusterMetric {
	out := &handshake.K8sClusterMetric{
		Enabled:              true,
		ClusterID:            ks.ClusterID,
		APIServerReachable:   ks.APIServerReachable,
		APIServerLatencyMs:   ks.APIServerLatencyMs,
		APIServerError:       ks.APIServerError,
		NodesTotal:           ks.NodesTotal,
		NodesReady:           ks.NodesReady,
		PodsPending:          ks.PodsPending,
		PodsCrashLoop:        ks.PodsCrashLoop,
		PodsTotal:            ks.PodsTotal,
		DeploymentsTotal:     ks.DeploymentsTotal,
		DeploymentsUnhealthy: ks.DeploymentsUnhealthy,
	}
	for _, n := range ks.NodesNotReady {
		out.NodesNotReady = append(out.NodesNotReady, handshake.K8sNodeMetric{
			Name: n.Name, Ready: n.Ready, Reason: n.Reason, Message: n.Message,
		})
	}
	for _, p := range ks.PodProblems {
		out.PodProblems = append(out.PodProblems, handshake.K8sPodProblemMetric{
			Namespace: p.Namespace, Name: p.Name, Phase: p.Phase, Reason: p.Reason,
			Restarts: p.Restarts, Problem: p.Problem,
		})
	}
	for _, p := range ks.Pods {
		pod := handshake.K8sPodMetric{
			Namespace: p.Namespace, Name: p.Name, Phase: p.Phase, Ready: p.Ready,
			Restarts: p.Restarts, Reason: p.Reason, Healthy: p.Healthy,
			NodeName: p.NodeName, CreatedAt: p.CreatedAt, LogTail: p.LogTail,
		}
		for _, c := range p.Conditions {
			pod.Conditions = append(pod.Conditions, handshake.K8sPodConditionMetric{
				Type: c.Type, Status: c.Status, Reason: c.Reason, Message: c.Message,
			})
		}
		for _, c := range p.Containers {
			pod.Containers = append(pod.Containers, handshake.K8sPodContainerMetric{
				Name: c.Name, Image: c.Image, Ready: c.Ready, Restarts: c.Restarts,
				State: c.State, Reason: c.Reason,
			})
		}
		if p.Resources != nil {
			pod.Resources = &handshake.K8sPodResourcesMetric{
				CPURequest: p.Resources.CPURequest, CPULimit: p.Resources.CPULimit,
				MemRequest: p.Resources.MemRequest, MemLimit: p.Resources.MemLimit,
			}
		}
		for _, e := range p.Events {
			pod.Events = append(pod.Events, handshake.K8sPodEventMetric{
				Type: e.Type, Reason: e.Reason, Message: e.Message,
				Count: e.Count, LastTimestamp: e.LastTimestamp,
			})
		}
		out.Pods = append(out.Pods, pod)
	}
	for _, d := range ks.Deployments {
		out.Deployments = append(out.Deployments, handshake.K8sDeploymentMetric{
			Namespace: d.Namespace, Name: d.Name, Desired: d.Desired,
			Ready: d.Ready, Available: d.Available, Healthy: d.Healthy,
		})
	}
	for _, s := range ks.ExposedServices {
		out.ExposedServices = append(out.ExposedServices, handshake.K8sServiceExposureMetric{
			Namespace: s.Namespace, Name: s.Name, Type: s.Type,
			ExternalIPs: s.ExternalIPs, NodePorts: s.NodePorts,
			LoadBalancerHosts: s.LoadBalancerHosts,
		})
	}
	if ks.NetworkPolicy != nil {
		out.NetworkPolicy = &handshake.K8sNetworkPolicySummary{
			NamespacesTotal:         ks.NetworkPolicy.NamespacesTotal,
			NamespacesWithPolicy:    ks.NetworkPolicy.NamespacesWithPolicy,
			NamespacesWithoutPolicy: ks.NetworkPolicy.NamespacesWithoutPolicy,
			WithoutPolicy:           ks.NetworkPolicy.WithoutPolicy,
		}
	}
	return out
}

func parseOptionalBoolFlag(raw string) *bool {
	raw = strings.TrimSpace(strings.ToLower(raw))
	if raw == "" {
		return nil
	}
	switch raw {
	case "1", "true", "yes", "on":
		t := true
		return &t
	case "0", "false", "no", "off":
		f := false
		return &f
	default:
		return nil
	}
}

func printUsage() {
	fmt.Fprintf(os.Stderr, `heimdall-agent %s

Usage:
  heimdall-agent register [--hub URL] [--token TOKEN] [--hostname NAME] [--cluster-id ID]
  heimdall-agent run [--hub URL] [--token TOKEN] [--hostname NAME] [--interval 10s] [--cluster-id ID]
  heimdall-agent collect [--watch-mounts /, /boot]
  heimdall-agent scan-image --image NAME [--hub URL] [--token TOKEN]
  heimdall-agent scan-host [--root PATH] [--hub URL] [--token TOKEN]
  heimdall-agent watch-logs [--log-paths /var/log/auth.log] [--hub URL] [--token TOKEN]
  heimdall-agent version

Environment:
  HEIMDALL_HUB_URL
  HEIMDALL_BOOTSTRAP_TOKEN
  HEIMDALL_HOSTNAME
  HEIMDALL_INTERVAL
  HEIMDALL_WATCH_MOUNTS
  HEIMDALL_LOG_PATHS
  HEIMDALL_CLUSTER_ID
  HEIMDALL_ENABLE_K8S
  HEIMDALL_TRIVY_BIN
  HEIMDALL_TRIVY_TIMEOUT
  HEIMDALL_HOST_ROOT
  HEIMDALL_HOST_POSTURE
  HEIMDALL_HOST_POSTURE_INTERVAL
  DOCKER_HOST_SOCKET / PODMAN_SOCKET
  KUBECONFIG / in-cluster service account
`, version)
}
