package containers

import (
	"errors"
	"testing"
	"time"
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

// A container that restarted a few times long ago and has been up for hours
// is not in a restart loop; the lifetime count alone must not keep it flagged.
func TestMarkRestartLoopsIgnoresStaleRestarts(t *testing.T) {
	now := time.Date(2026, 11, 14, 17, 28, 0, 0, time.UTC)
	items := []Snapshot{
		{ID: "stable", State: "running", RestartCount: 6, StartedAt: "2026-11-14T11:03:13.355101474Z"},
		{ID: "fresh", State: "running", RestartCount: 6, StartedAt: "2026-11-14T17:25:00Z"},
		{ID: "gaveup", State: "exited", RestartCount: 5, StartedAt: "2026-11-14T09:00:00Z", FinishedAt: "2026-11-14T09:00:05Z"},
		{ID: "justdied", State: "exited", RestartCount: 5, StartedAt: "2026-11-14T17:20:00Z", FinishedAt: "2026-11-14T17:27:00Z"},
		{ID: "unknown", State: "running", RestartCount: 4, StartedAt: "0001-01-01T00:00:00Z"},
	}
	markRestartLoopsAt(items, now)
	want := map[string]bool{"stable": false, "fresh": true, "gaveup": false, "justdied": true, "unknown": true}
	for _, it := range items {
		if it.RestartLoop != want[it.ID] {
			t.Errorf("%s: restartLoop=%v want %v", it.ID, it.RestartLoop, want[it.ID])
		}
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
