package vulns

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestScanImageMissingBinary(t *testing.T) {
	t.Setenv("HEIMDALL_TRIVY_BIN", "trivy-does-not-exist-heimdall")
	_, err := ScanImage("nginx:1.21", 0)
	if err == nil {
		t.Fatal("expected error when trivy binary missing")
	}
}

func TestScanRootfsMissingBinary(t *testing.T) {
	t.Setenv("HEIMDALL_TRIVY_BIN", "trivy-does-not-exist-heimdall")
	_, err := ScanRootfs("/tmp", 0)
	if err == nil {
		t.Fatal("expected error when trivy binary missing")
	}
}

func TestScanImageWithFakeTrivy(t *testing.T) {
	dir := t.TempDir()
	reportPath := filepath.Join(dir, "report.json")
	report := []byte(`{"Results":[{"Target":"nginx:fake","Vulnerabilities":[{"VulnerabilityID":"CVE-TEST","PkgName":"x","Severity":"HIGH","Title":"t"}]}]}`)
	if err := os.WriteFile(reportPath, report, 0o644); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(dir, "trivy")
	content := "#!/bin/sh\ncat '" + reportPath + "'\n"
	if err := os.WriteFile(script, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HEIMDALL_TRIVY_BIN", script)

	raw, err := ScanImage("nginx:fake", 0)
	if err != nil {
		t.Fatalf("ScanImage: %v", err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("json: %v", err)
	}
	results, ok := parsed["Results"].([]any)
	if !ok || len(results) != 1 {
		t.Fatalf("unexpected report: %s", string(raw))
	}
}

func TestScanRootfsWithFakeTrivy(t *testing.T) {
	dir := t.TempDir()
	reportPath := filepath.Join(dir, "report.json")
	report := []byte(`{"Results":[{"Target":"rootfs","Misconfigurations":[{"ID":"DSV-1","Severity":"HIGH","Title":"t"}]}]}`)
	if err := os.WriteFile(reportPath, report, 0o644); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(dir, "trivy")
	// Echo args to a side file so we can assert rootfs + scanners flags.
	argsPath := filepath.Join(dir, "args.txt")
	content := "#!/bin/sh\necho \"$@\" > '" + argsPath + "'\ncat '" + reportPath + "'\n"
	if err := os.WriteFile(script, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HEIMDALL_TRIVY_BIN", script)

	root := filepath.Join(dir, "root")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	raw, err := ScanRootfs(root, 0)
	if err != nil {
		t.Fatalf("ScanRootfs: %v", err)
	}
	args, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatal(err)
	}
	got := string(args)
	if !containsAll(got, "rootfs", "--scanners", "vuln,misconfig", root) {
		t.Fatalf("unexpected trivy args: %q", got)
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("json: %v", err)
	}
}

func TestResolveHostRoot(t *testing.T) {
	t.Setenv("HEIMDALL_HOST_ROOT", "/custom/root")
	if got := ResolveHostRoot(); got != "/custom/root" {
		t.Fatalf("got %q", got)
	}
}

func containsAll(s string, parts ...string) bool {
	for _, p := range parts {
		if !contains(s, p) {
			return false
		}
	}
	return true
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 ||
		indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
