package collect

import (
	"bufio"
	"bytes"
	"strings"
)

type mountEntry struct {
	device     string
	mountPoint string
	fsType     string
}

func parseMounts(raw []byte) []mountEntry {
	var out []mountEntry
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 3 {
			continue
		}
		out = append(out, mountEntry{
			device:     fields[0],
			mountPoint: fields[1],
			fsType:     fields[2],
		})
	}
	return out
}

// findMount returns the effective mount at path. An autofs entry is only a
// trigger: when the real filesystem (e.g. CIFS) is down, autofs is all that
// remains in /proc/mounts, so autofs-only counts as missing. When several real
// filesystems stack on the same path, the last one listed is the visible one.
func findMount(entries []mountEntry, path string) (mountEntry, bool) {
	var found mountEntry
	ok := false
	for _, e := range entries {
		if e.mountPoint == path && e.fsType != "autofs" {
			found, ok = e, true
		}
	}
	return found, ok
}

func sampleMounts(r Reader, watch []string, diskUsage DiskUsageFunc) ([]MountSample, []DiskSample, error) {
	raw, err := r.ReadFile("/proc/mounts")
	if err != nil {
		return nil, nil, err
	}
	entries := parseMounts(raw)

	mounts := make([]MountSample, 0, len(watch))
	disks := make([]DiskSample, 0, len(watch))

	for _, path := range watch {
		entry, present := findMount(entries, path)
		sample := MountSample{Path: path, Present: present}
		if present {
			sample.FSType = entry.fsType
			sample.Device = entry.device
			if diskUsage != nil {
				total, free, usageErr := diskUsage(path)
				if usageErr == nil && total > 0 {
					used := total - free
					if used < 0 {
						used = 0
					}
					pct := (float64(used) / float64(total)) * 100
					sample.TotalBytes = total
					sample.UsedBytes = used
					sample.UsedPercent = pct
					disks = append(disks, DiskSample{
						MountPoint:  path,
						Device:      entry.device,
						TotalBytes:  total,
						UsedBytes:   used,
						FreeBytes:   free,
						UsedPercent: pct,
					})
				}
			}
		}
		mounts = append(mounts, sample)
	}
	return mounts, disks, nil
}
