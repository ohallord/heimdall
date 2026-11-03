// Package state persists the per-agent secret returned by the hub at registration.
package state

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

const secretFile = "agent-secret"

// Dir resolves the state directory: HEIMDALL_STATE_DIR, else /var/lib/heimdall if
// writable, else ~/.heimdall.
func Dir() string {
	if d := strings.TrimSpace(os.Getenv("HEIMDALL_STATE_DIR")); d != "" {
		return d
	}
	const system = "/var/lib/heimdall"
	if writable(system) {
		return system
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".heimdall")
	}
	return system
}

func writable(dir string) bool {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return false
	}
	f, err := os.CreateTemp(dir, ".probe-*")
	if err != nil {
		return false
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return true
}

// Store reads and writes the agent secret in a directory (file mode 0600).
type Store struct{ dir string }

func NewStore(dir string) *Store { return &Store{dir: dir} }

// Load returns the stored secret, or "" if none exists.
func (s *Store) Load() (string, error) {
	raw, err := os.ReadFile(filepath.Join(s.dir, secretFile))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(raw)), nil
}

// Save atomically writes the secret with 0600 permissions (directory 0700).
func (s *Store) Save(secret string) error {
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.dir, ".agent-secret-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.WriteString(secret + "\n"); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), filepath.Join(s.dir, secretFile))
}
