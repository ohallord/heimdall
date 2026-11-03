package containers

import (
	"errors"
	"testing"
)

func TestMarkRestartLoops(t *testing.T) {
	items := []Snapshot{
		{ID: "a", State: "running", RestartCount: 1},
		{ID: "b", State: "running", RestartCount: 3},
		{ID: "c", State: "restarting", RestartCount: 0},
	}
	MarkRestartLoops(items)
	if items[0].RestartLoop {
		t.Fatal("low restart count should not loop")
	}
	if !items[1].RestartLoop || !items[2].RestartLoop {
		t.Fatal("expected restart loop flags")
	}
}

func TestCollectMockedRuntime(t *testing.T) {
	exit := 137
	cpu := 42.5
	memPct := 80.0
	memUse := int64(800)
	memLimit := int64(1000)

	rt := &MockRuntime{
		RuntimeName: "docker",
		Items: []Snapshot{
			{
				ID: "abc123", Name: "api", Image: "api:1", State: "running",
				Status: "Up 2 minutes", RestartCount: 0,
				CPUPercent: &cpu, MemUsageBytes: &memUse, MemLimitBytes: &memLimit, MemPercent: &memPct,
			},
			{
				ID: "def456", Name: "worker", Image: "worker:1", State: "exited",
				Status: "Exited (137)", ExitCode: &exit, OOMKilled: true, RestartCount: 5,
			},
		},
	}

	sample, err := Collect(rt)
	if err != nil {
		t.Fatal(err)
	}
	if sample.Runtime != "docker" {
		t.Fatalf("runtime=%s", sample.Runtime)
	}
	if len(sample.Containers) != 2 {
		t.Fatalf("len=%d", len(sample.Containers))
	}
	if !sample.Containers[1].RestartLoop {
		t.Fatal("oom/exited high restart should mark loop")
	}
	if !sample.Containers[1].OOMKilled || sample.Containers[1].ExitCode == nil || *sample.Containers[1].ExitCode != 137 {
		t.Fatalf("oom snapshot: %+v", sample.Containers[1])
	}
	if sample.Containers[0].MemPercent == nil || *sample.Containers[0].MemPercent != 80 {
		t.Fatalf("mem limit pct missing: %+v", sample.Containers[0])
	}
}

func TestCollectNilRuntime(t *testing.T) {
	sample, err := Collect(nil)
	if err != nil {
		t.Fatal(err)
	}
	if sample.Runtime != "none" || len(sample.Containers) != 0 {
		t.Fatalf("unexpected: %+v", sample)
	}
}

func TestCollectRuntimeError(t *testing.T) {
	_, err := Collect(&MockRuntime{Err: errors.New("socket down")})
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestApplyStatsRespectsLimits(t *testing.T) {
	snap := Snapshot{}
	stats := dockerStats{}
	stats.CPUStats.CPUUsage.TotalUsage = 200
	stats.PreCPUStats.CPUUsage.TotalUsage = 100
	stats.CPUStats.SystemUsage = 1000
	stats.PreCPUStats.SystemUsage = 500
	stats.CPUStats.OnlineCPUs = 2
	stats.MemoryStats.Usage = 50
	stats.MemoryStats.Limit = 100
	applyStats(&snap, stats)
	if snap.CPUPercent == nil || *snap.CPUPercent <= 0 {
		t.Fatalf("cpu=%v", snap.CPUPercent)
	}
	if snap.MemPercent == nil || *snap.MemPercent != 50 {
		t.Fatalf("memPct=%v", snap.MemPercent)
	}
}
