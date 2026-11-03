package state

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStoreRoundTripAndPerms(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested")
	s := NewStore(dir)
	if got, err := s.Load(); err != nil || got != "" {
		t.Fatalf("empty load = %q, %v", got, err)
	}
	if err := s.Save("hda_abc"); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Load(); got != "hda_abc" {
		t.Fatalf("load = %q", got)
	}
	info, err := os.Stat(filepath.Join(dir, "agent-secret"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, err %v; want 0600", info.Mode().Perm(), err)
	}
	di, _ := os.Stat(dir)
	if di.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode = %v; want 0700", di.Mode().Perm())
	}
}

func TestDirEnvOverride(t *testing.T) {
	t.Setenv("HEIMDALL_STATE_DIR", "/custom/state")
	if Dir() != "/custom/state" {
		t.Fatalf("Dir = %s", Dir())
	}
}
