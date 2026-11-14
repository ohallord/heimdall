package containers

import "time"

// Snapshot is one container's health view for hub ingest.
type Snapshot struct {
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

type Sample struct {
	CollectedAt time.Time  `json:"collectedAt"`
	Runtime     string     `json:"runtime"` // docker | podman | none
	Containers  []Snapshot `json:"containers"`
}

// Runtime abstracts Docker/Podman Engine API access for tests.
type Runtime interface {
	Name() string
	List() ([]Snapshot, error)
}

const RestartLoopThreshold = 3

// RestartLoopWindow is how recently a container must have started or stopped
// for its restart count to count as a loop. Docker only reports a lifetime
// restart count, so without this a container that restarted a few times and
// then ran for days would stay flagged forever.
const RestartLoopWindow = 10 * time.Minute

func MarkRestartLoops(items []Snapshot) {
	markRestartLoopsAt(items, time.Now())
}

func markRestartLoopsAt(items []Snapshot, now time.Time) {
	for i := range items {
		it := &items[i]
		it.RestartLoop = it.State == "restarting" ||
			(it.RestartCount >= RestartLoopThreshold && recentlyCycled(*it, now))
	}
}

// recentlyCycled reports whether the container started or stopped within
// RestartLoopWindow. When neither time is known it returns true, so a high
// restart count still flags rather than going silent.
func recentlyCycled(s Snapshot, now time.Time) bool {
	known := false
	for _, ts := range []string{s.StartedAt, s.FinishedAt} {
		t, err := time.Parse(time.RFC3339Nano, ts)
		if err != nil || t.Year() <= 1 {
			continue
		}
		known = true
		if now.Sub(t) <= RestartLoopWindow {
			return true
		}
	}
	return !known
}
