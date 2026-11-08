package collect

import (
	"time"

	"golang.org/x/sys/unix"
)

type Options struct {
	Reader    Reader
	DiskUsage DiskUsageFunc
	// WatchMounts is the expect list: only these paths can be reported missing.
	WatchMounts []string
	// HostRoot scopes mount discovery ("/" bare metal, "/host" in containers).
	HostRoot      string
	CPUSampleWait time.Duration
}

func defaultDiskUsage(path string) (total, free int64, err error) {
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return 0, 0, err
	}
	total = int64(st.Blocks) * int64(st.Bsize)
	free = int64(st.Bavail) * int64(st.Bsize)
	return total, free, nil
}

func Collect(opts Options) (HostSample, error) {
	r := opts.Reader
	if r == nil {
		r = OSReader{}
	}
	diskUsage := opts.DiskUsage
	if diskUsage == nil {
		diskUsage = defaultDiskUsage
	}
	hostRoot := opts.HostRoot
	if hostRoot == "" {
		hostRoot = "/"
	}
	watch := opts.WatchMounts
	if len(watch) == 0 {
		watch = DefaultExpectMounts(hostRoot)
	}
	wait := opts.CPUSampleWait
	if wait == 0 {
		wait = 120 * time.Millisecond
	}

	cpu, err := sampleCPUPercent(r, wait)
	if err != nil {
		return HostSample{}, err
	}
	memUsed, memTotal, memPct, err := sampleMemory(r)
	if err != nil {
		return HostSample{}, err
	}
	load1, load5, load15, err := sampleLoad(r)
	if err != nil {
		return HostSample{}, err
	}
	mounts, disks, err := sampleMounts(r, watch, hostRoot, diskUsage)
	if err != nil {
		return HostSample{}, err
	}

	return HostSample{
		CollectedAt:   time.Now().UTC(),
		CPUPercent:    round1(cpu),
		MemPercent:    round1(memPct),
		MemUsedBytes:  memUsed,
		MemTotalBytes: memTotal,
		Load1:         round2(load1),
		Load5:         round2(load5),
		Load15:        round2(load15),
		Disks:         disks,
		Mounts:        mounts,
	}, nil
}

func round1(v float64) float64 {
	return float64(int(v*10+0.5)) / 10
}

func round2(v float64) float64 {
	return float64(int(v*100+0.5)) / 100
}
