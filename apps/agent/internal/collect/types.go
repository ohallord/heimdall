package collect

import "time"

// HostSample is one scrape of host health signals.
type HostSample struct {
	CollectedAt time.Time     `json:"collectedAt"`
	CPUPercent  float64       `json:"cpuPercent"`
	MemPercent  float64       `json:"memPercent"`
	MemUsedBytes int64        `json:"memUsedBytes"`
	MemTotalBytes int64       `json:"memTotalBytes"`
	Load1       float64       `json:"load1"`
	Load5       float64       `json:"load5"`
	Load15      float64       `json:"load15"`
	Disks       []DiskSample  `json:"disks"`
	Mounts      []MountSample `json:"mounts"`
}

type DiskSample struct {
	MountPoint  string  `json:"mountPoint"`
	Device      string  `json:"device"`
	TotalBytes  int64   `json:"totalBytes"`
	UsedBytes   int64   `json:"usedBytes"`
	FreeBytes   int64   `json:"freeBytes"`
	UsedPercent float64 `json:"usedPercent"`
}

type MountSample struct {
	Path     string `json:"path"`
	Present  bool   `json:"present"`
	FSType   string `json:"fsType,omitempty"`
	Device   string `json:"device,omitempty"`
	TotalBytes int64 `json:"totalBytes,omitempty"`
	UsedBytes  int64 `json:"usedBytes,omitempty"`
	UsedPercent float64 `json:"usedPercent,omitempty"`
}

// WatchMounts are paths the agent must report presence for.
var DefaultWatchMounts = []string{"/", "/boot", "/var"}
