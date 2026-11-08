package collect

import (
	"bufio"
	"bytes"
	"strconv"
	"strings"
)

type mountEntry struct {
	device     string
	mountPoint string
	fsType     string
}

// maxDiscoveredMounts caps the inventory so bind-heavy hosts cannot bloat the payload.
const maxDiscoveredMounts = 64

// Filesystem types that are never operator-facing storage: kernel pseudo filesystems,
// memory-backed tmpfs, snap squashfs images and container overlays.
var nonStorageFSTypes = map[string]bool{
	"proc": true, "sysfs": true, "devtmpfs": true, "devpts": true, "tmpfs": true,
	"cgroup": true, "cgroup2": true, "pstore": true, "bpf": true, "debugfs": true,
	"tracefs": true, "securityfs": true, "hugetlbfs": true, "mqueue": true,
	"configfs": true, "fusectl": true, "binfmt_misc": true, "autofs": true,
	"rpc_pipefs": true, "nsfs": true, "efivarfs": true, "ramfs": true,
	"squashfs": true, "overlay": true, "fuse.lxcfs": true, "fuse.portal": true,
	"fuse.gvfsd-fuse": true,
}

// DefaultExpectMounts is the must-present list when none is configured: only the
// (host) root. Directories such as /var or /boot are not mounts unless /proc/mounts says so.
func DefaultExpectMounts(hostRoot string) []string {
	if hostRoot == "" {
		hostRoot = "/"
	}
	return []string{hostRoot}
}

// unescapeMountField decodes the octal escapes /proc/mounts uses for space, tab,
// newline and backslash (e.g. `\040`).
func unescapeMountField(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+4 <= len(s) {
			if n, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
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
			device:     unescapeMountField(fields[0]),
			mountPoint: unescapeMountField(fields[1]),
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

func underRoot(path, root string) bool {
	if root == "" || root == "/" {
		return true
	}
	return path == root || strings.HasPrefix(path, strings.TrimSuffix(root, "/")+"/")
}

// discoverMounts lists real storage mounts under hostRoot, in /proc/mounts order.
// One row per device (shortest mount point wins), so bind mounts of the same
// filesystem (docker volumes, kubelet file binds) collapse into their parent.
func discoverMounts(entries []mountEntry, hostRoot string) []mountEntry {
	byDevice := map[string]int{}
	var out []mountEntry
	for _, e := range entries {
		if nonStorageFSTypes[e.fsType] || !underRoot(e.mountPoint, hostRoot) {
			continue
		}
		if i, ok := byDevice[e.device]; ok {
			if len(e.mountPoint) < len(out[i].mountPoint) {
				out[i] = e
			}
			continue
		}
		byDevice[e.device] = len(out)
		out = append(out, e)
	}
	return out
}

func diskSample(e mountEntry, path string, diskUsage DiskUsageFunc) (DiskSample, bool) {
	if diskUsage == nil {
		return DiskSample{}, false
	}
	total, free, err := diskUsage(path)
	if err != nil || total <= 0 {
		return DiskSample{}, false
	}
	used := total - free
	if used < 0 {
		used = 0
	}
	return DiskSample{
		MountPoint:  path,
		Device:      e.device,
		FSType:      e.fsType,
		TotalBytes:  total,
		UsedBytes:   used,
		FreeBytes:   free,
		UsedPercent: (float64(used) / float64(total)) * 100,
	}, true
}

// sampleMounts returns expected-mount presence rows (only these can be "missing")
// and disk usage for every discovered filesystem plus present expected paths.
func sampleMounts(r Reader, expect []string, hostRoot string, diskUsage DiskUsageFunc) ([]MountSample, []DiskSample, error) {
	raw, err := r.ReadFile("/proc/mounts")
	if err != nil {
		return nil, nil, err
	}
	entries := parseMounts(raw)

	mounts := make([]MountSample, 0, len(expect))
	disks := make([]DiskSample, 0, len(expect))
	seen := map[string]bool{}
	addDisk := func(e mountEntry) (DiskSample, bool) {
		if seen[e.mountPoint] || len(disks) >= maxDiscoveredMounts {
			return DiskSample{}, false
		}
		d, ok := diskSample(e, e.mountPoint, diskUsage)
		if ok {
			seen[e.mountPoint] = true
			disks = append(disks, d)
		}
		return d, ok
	}

	for _, path := range expect {
		entry, present := findMount(entries, path)
		sample := MountSample{Path: path, Present: present}
		if present {
			sample.FSType = entry.fsType
			sample.Device = entry.device
			if d, ok := addDisk(entry); ok {
				sample.TotalBytes = d.TotalBytes
				sample.UsedBytes = d.UsedBytes
				sample.UsedPercent = d.UsedPercent
			}
		}
		mounts = append(mounts, sample)
	}
	for _, e := range discoverMounts(entries, hostRoot) {
		addDisk(e)
	}
	return mounts, disks, nil
}
