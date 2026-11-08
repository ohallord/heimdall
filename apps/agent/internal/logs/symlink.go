package logs

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// FollowSymlinksEnv opts in to tailing a log path whose final component is a symlink.
const FollowSymlinksEnv = "HEIMDALL_LOG_FOLLOW_SYMLINKS"

// symlinkTrustedDirs hold kubelet-managed symlinks (/var/log/containers/*.log ->
// /var/log/pods/...) that must keep working without the opt-in.
var symlinkTrustedDirs = []string{"/var/log/containers", "/var/log/pods"}

// checkSymlink refuses a path whose final component is a symlink: a writable log
// directory would otherwise let a local user point the (often root) agent at any
// file (/etc/shadow) and ship it to the hub. Missing paths pass (handled by Open).
func checkSymlink(path string) error {
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		return nil
	}
	if followSymlinks() || underTrustedDir(path) {
		return nil
	}
	return fmt.Errorf("refusing to follow symlink %s (set %s=1 to allow)", path, FollowSymlinksEnv)
}

func followSymlinks() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(FollowSymlinksEnv))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func underTrustedDir(path string) bool {
	clean := filepath.Clean(path)
	for _, dir := range symlinkTrustedDirs {
		if strings.HasPrefix(clean, dir+string(filepath.Separator)) {
			return true
		}
	}
	return false
}
