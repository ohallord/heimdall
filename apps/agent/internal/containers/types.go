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

func MarkRestartLoops(items []Snapshot) {
	for i := range items {
		items[i].RestartLoop = items[i].State == "restarting" || items[i].RestartCount >= RestartLoopThreshold
	}
}
