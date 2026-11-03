package vulns

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// ScanImage runs `trivy image --format json` when the binary is available.
// Returns the raw JSON report for the hub to parse.
func ScanImage(image string, timeout time.Duration) (json.RawMessage, error) {
	image = strings.TrimSpace(image)
	if image == "" {
		return nil, fmt.Errorf("image is required")
	}
	if timeout <= 0 {
		timeout = 2 * time.Minute
	}
	return runTrivy(timeout, "image", "--quiet", "--format", "json", image)
}

// ScanRootfs runs `trivy rootfs --scanners vuln,misconfig --format json`.
// Returns the raw JSON report for the hub to parse as host_posture.
func ScanRootfs(root string, timeout time.Duration) (json.RawMessage, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		root = ResolveHostRoot()
	}
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	return runTrivy(timeout,
		"rootfs", "--quiet", "--format", "json",
		"--scanners", "vuln,misconfig",
		root,
	)
}

// ResolveHostRoot picks HEIMDALL_HOST_ROOT, else /host if present, else /.
func ResolveHostRoot() string {
	if v := strings.TrimSpace(os.Getenv("HEIMDALL_HOST_ROOT")); v != "" {
		return v
	}
	if st, err := os.Stat("/host"); err == nil && st.IsDir() {
		return "/host"
	}
	return "/"
}

func runTrivy(timeout time.Duration, args ...string) (json.RawMessage, error) {
	bin := firstNonEmpty(os.Getenv("HEIMDALL_TRIVY_BIN"), "trivy")
	if _, err := exec.LookPath(bin); err != nil {
		return nil, fmt.Errorf("trivy not found on PATH (%s): %w", bin, err)
	}

	cmd := exec.Command(bin, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	done := make(chan error, 1)
	go func() { done <- cmd.Run() }()

	select {
	case err := <-done:
		if err != nil {
			return nil, fmt.Errorf("trivy failed: %w (%s)", err, strings.TrimSpace(stderr.String()))
		}
	case <-time.After(timeout):
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("trivy timed out after %s", timeout)
	}

	raw := bytes.TrimSpace(stdout.Bytes())
	if len(raw) == 0 {
		return nil, fmt.Errorf("trivy returned empty report")
	}
	if !json.Valid(raw) {
		return nil, fmt.Errorf("trivy output is not valid JSON")
	}
	return json.RawMessage(raw), nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
