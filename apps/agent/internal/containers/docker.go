package containers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

type DockerRuntime struct {
	name   string
	client *http.Client
	base   string
}

func DetectRuntime() Runtime {
	candidates := []struct {
		name   string
		socket string
	}{
		{name: "docker", socket: envOr("DOCKER_HOST_SOCKET", "/var/run/docker.sock")},
		{name: "podman", socket: envOr("PODMAN_SOCKET", "/run/podman/podman.sock")},
		{name: "podman", socket: envOr("XDG_RUNTIME_DIR", "/run/user/1000") + "/podman/podman.sock"},
	}
	for _, c := range candidates {
		if st, err := os.Stat(c.socket); err == nil && !st.IsDir() {
			return NewDockerRuntime(c.name, c.socket)
		}
	}
	return nil
}

func NewDockerRuntime(name, socketPath string) *DockerRuntime {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
		},
	}
	return &DockerRuntime{
		name: name,
		base: "http://localhost",
		client: &http.Client{
			Timeout:   8 * time.Second,
			Transport: transport,
		},
	}
}

func (d *DockerRuntime) Name() string { return d.name }

func (d *DockerRuntime) List() ([]Snapshot, error) {
	resp, err := d.client.Get(d.base + "/containers/json?all=1")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("list containers: %s", strings.TrimSpace(string(body)))
	}

	var listed []dockerListItem
	if err := json.NewDecoder(resp.Body).Decode(&listed); err != nil {
		return nil, err
	}

	out := make([]Snapshot, 0, len(listed))
	for _, item := range listed {
		snap := Snapshot{
			ID:     shortID(item.ID),
			Name:   firstName(item.Names),
			Image:  item.Image,
			State:  strings.ToLower(item.State),
			Status: item.Status,
		}
		insp, err := d.inspect(item.ID)
		if err == nil {
			snap.RestartCount = insp.RestartCount
			snap.OOMKilled = insp.State.OOMKilled
			if insp.State.ExitCode != 0 || snap.State == "exited" {
				code := insp.State.ExitCode
				snap.ExitCode = &code
			}
			snap.StartedAt = insp.State.StartedAt
			snap.FinishedAt = insp.State.FinishedAt
		}
		if snap.State == "running" {
			if stats, err := d.stats(item.ID); err == nil {
				applyStats(&snap, stats)
			}
		}
		out = append(out, snap)
	}
	MarkRestartLoops(out)
	return out, nil
}

func (d *DockerRuntime) inspect(id string) (dockerInspect, error) {
	resp, err := d.client.Get(d.base + "/containers/" + id + "/json")
	if err != nil {
		return dockerInspect{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return dockerInspect{}, fmt.Errorf("inspect %s: status %d", id, resp.StatusCode)
	}
	var out dockerInspect
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return dockerInspect{}, err
	}
	return out, nil
}

func (d *DockerRuntime) stats(id string) (dockerStats, error) {
	resp, err := d.client.Get(d.base + "/containers/" + id + "/stats?stream=false")
	if err != nil {
		return dockerStats{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return dockerStats{}, fmt.Errorf("stats %s: status %d", id, resp.StatusCode)
	}
	var out dockerStats
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return dockerStats{}, err
	}
	return out, nil
}

type dockerListItem struct {
	ID     string   `json:"Id"`
	Names  []string `json:"Names"`
	Image  string   `json:"Image"`
	State  string   `json:"State"`
	Status string   `json:"Status"`
}

type dockerInspect struct {
	RestartCount int `json:"RestartCount"`
	State        struct {
		Status     string `json:"Status"`
		Running    bool   `json:"Running"`
		OOMKilled  bool   `json:"OOMKilled"`
		ExitCode   int    `json:"ExitCode"`
		StartedAt  string `json:"StartedAt"`
		FinishedAt string `json:"FinishedAt"`
	} `json:"State"`
	HostConfig struct {
		Memory int64 `json:"Memory"`
		NanoCPUs int64 `json:"NanoCpus"`
	} `json:"HostConfig"`
}

type dockerStats struct {
	CPUStats struct {
		CPUUsage struct {
			TotalUsage  uint64   `json:"total_usage"`
			PercpuUsage []uint64 `json:"percpu_usage"`
		} `json:"cpu_usage"`
		SystemUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs  uint32 `json:"online_cpus"`
	} `json:"cpu_stats"`
	PreCPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemUsage uint64 `json:"system_cpu_usage"`
	} `json:"precpu_stats"`
	MemoryStats struct {
		Usage uint64 `json:"usage"`
		Limit uint64 `json:"limit"`
	} `json:"memory_stats"`
}

func applyStats(snap *Snapshot, stats dockerStats) {
	cpuDelta := float64(stats.CPUStats.CPUUsage.TotalUsage - stats.PreCPUStats.CPUUsage.TotalUsage)
	sysDelta := float64(stats.CPUStats.SystemUsage - stats.PreCPUStats.SystemUsage)
	online := float64(stats.CPUStats.OnlineCPUs)
	if online == 0 {
		online = float64(len(stats.CPUStats.CPUUsage.PercpuUsage))
	}
	if online == 0 {
		online = 1
	}
	if sysDelta > 0 && cpuDelta >= 0 {
		pct := (cpuDelta / sysDelta) * online * 100
		snap.CPUPercent = &pct
	}

	usage := int64(stats.MemoryStats.Usage)
	limit := int64(stats.MemoryStats.Limit)
	snap.MemUsageBytes = &usage
	// Host-wide limit masquerades as container limit when unset; only treat
	// smaller explicit limits as cgroup container limits (< 1<<62 heuristic).
	if limit > 0 && limit < (1<<62) {
		snap.MemLimitBytes = &limit
		pct := (float64(usage) / float64(limit)) * 100
		snap.MemPercent = &pct
	}
}

func shortID(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

func firstName(names []string) string {
	if len(names) == 0 {
		return ""
	}
	return strings.TrimPrefix(names[0], "/")
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
