package logs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadNewLinesRefusesSymlink(t *testing.T) {
	dir := t.TempDir()
	secret := filepath.Join(dir, "shadow")
	if err := os.WriteFile(secret, []byte("root:hash\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "app.log")
	if err := os.Symlink(secret, link); err != nil {
		t.Fatal(err)
	}

	t.Setenv(FollowSymlinksEnv, "")
	lines, _, err := ReadNewLines(link, 0, 10)
	if err == nil || !strings.Contains(err.Error(), FollowSymlinksEnv) {
		t.Fatalf("expected symlink refusal, got lines=%v err=%v", lines, err)
	}
	if len(lines) != 0 {
		t.Fatalf("leaked symlink target: %v", lines)
	}

	t.Setenv(FollowSymlinksEnv, "1")
	lines, _, err = ReadNewLines(link, 0, 10)
	if err != nil || len(lines) != 1 {
		t.Fatalf("opt-in follow failed: lines=%v err=%v", lines, err)
	}
}

func TestKubeletLogDirsTrusted(t *testing.T) {
	for _, p := range []string{
		"/var/log/containers/app_ns_c-abc.log",
		"/var/log/pods/ns_app_uid/c/0.log",
	} {
		if !underTrustedDir(p) {
			t.Errorf("%s should be trusted", p)
		}
	}
	for _, p := range []string{"/var/log/containers", "/var/log/containers-evil/x.log", "/var/log/auth.log", "/var/log/pods/../../etc/shadow"} {
		if underTrustedDir(p) {
			t.Errorf("%s should not be trusted", p)
		}
	}
}
