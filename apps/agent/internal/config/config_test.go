package config

import "testing"

func TestLoadWithoutTokenFails(t *testing.T) {
	t.Setenv("HEIMDALL_BOOTSTRAP_TOKEN", "")
	t.Setenv("HEIMDALL_HOSTNAME", "fixture-host")
	if _, err := Load(Overrides{Version: "0.0.1"}); err == nil {
		t.Fatal("expected error when no token is configured")
	}
}

func TestLoadDefaults(t *testing.T) {
	t.Setenv("HEIMDALL_HUB_URL", "")
	t.Setenv("HEIMDALL_BOOTSTRAP_TOKEN", "tok")
	t.Setenv("HEIMDALL_HOSTNAME", "fixture-host")
	t.Setenv("HEIMDALL_ENABLE_K8S", "")

	cfg, err := Load(Overrides{Version: "0.0.1"})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.HubURL != "http://127.0.0.1:43123" {
		t.Fatalf("hub url: %s", cfg.HubURL)
	}
	if cfg.Hostname != "fixture-host" {
		t.Fatalf("hostname: %s", cfg.Hostname)
	}
	if cfg.EnableK8s {
		t.Fatalf("EnableK8s should default false for Compose/bare hosts")
	}
}

func TestLoadEnableK8sEnv(t *testing.T) {
	t.Setenv("HEIMDALL_BOOTSTRAP_TOKEN", "tok")
	t.Setenv("HEIMDALL_HOSTNAME", "fixture-host")
	t.Setenv("HEIMDALL_ENABLE_K8S", "true")
	cfg, err := Load(Overrides{Version: "0.0.1"})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.EnableK8s {
		t.Fatalf("expected EnableK8s true from env")
	}
}

func TestLoadEnableK8sExplicitCLIWinsOverEnv(t *testing.T) {
	t.Setenv("HEIMDALL_BOOTSTRAP_TOKEN", "tok")
	t.Setenv("HEIMDALL_HOSTNAME", "fixture-host")
	t.Setenv("HEIMDALL_ENABLE_K8S", "true")
	cliFalse := false
	cfg, err := Load(Overrides{Version: "0.0.1", EnableK8s: &cliFalse})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.EnableK8s {
		t.Fatalf("explicit --enable-k8s=false must win over env true (Compose force-off)")
	}
}

func TestLoadEnableK8sEnvWhenCLIUnset(t *testing.T) {
	t.Setenv("HEIMDALL_BOOTSTRAP_TOKEN", "tok")
	t.Setenv("HEIMDALL_HOSTNAME", "fixture-host")
	t.Setenv("HEIMDALL_ENABLE_K8S", "0")
	cfg, err := Load(Overrides{Version: "0.0.1", EnableK8s: nil})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.EnableK8s {
		t.Fatalf("env 0 must disable when CLI unset")
	}
}

func TestParseBoolFalsy(t *testing.T) {
	for _, raw := range []string{"false", "0", "no", "off", "FALSE", " False "} {
		if parseBool(raw, true) {
			t.Fatalf("parseBool(%q) want false", raw)
		}
	}
	if parseBool("", true) != true {
		t.Fatal("empty should use fallback true")
	}
	if parseBool("", false) != false {
		t.Fatal("empty should use fallback false")
	}
	for _, raw := range []string{"true", "1", "yes", "on"} {
		if !parseBool(raw, false) {
			t.Fatalf("parseBool(%q) want true", raw)
		}
	}
}
