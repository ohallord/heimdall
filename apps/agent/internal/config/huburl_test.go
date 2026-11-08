package config

import (
	"strings"
	"testing"
)

func TestCheckHubURL(t *testing.T) {
	cases := []struct {
		url      string
		insecure bool
		ok       bool
		warn     bool
	}{
		{"https://heimdall.example.com", false, true, false},
		{"https://192.168.5.8:43123", false, true, false},
		{"http://127.0.0.1:43123", false, true, false},
		{"http://localhost:43123", false, true, false},
		{"http://[::1]:43123", false, true, false},
		{"http://hub:43123", false, true, true},          // compose service
		{"http://heimdall-hub:43123", false, true, true}, // helm in-namespace Service
		{"http://heimdall-hub.heimdall.svc:43123", false, true, true},
		{"http://heimdall-hub.heimdall.svc.cluster.local:43123", false, true, true},
		{"http://192.168.5.8:43123", false, true, true}, // LAN hub: allowed, warned
		{"http://10.0.0.4:43123", false, true, true},
		{"http://100.100.1.2:43123", false, true, true}, // tailnet / CGNAT
		{"http://[fd00::5]:43123", false, true, true},
		{"http://heimdall.lan:43123", false, true, true},
		{"http://203.0.113.10:43123", false, false, false}, // public IP: refused
		{"http://heimdall.example.com", false, false, false},
		{"http://heimdall.example.com", true, true, true},
		{"http://192.168.5.8:43123", true, true, true},
		{"ftp://heimdall.example.com", true, false, false},
		{"heimdall.example.com", true, false, false},
	}
	for _, c := range cases {
		warn, err := CheckHubURL(c.url, c.insecure)
		if (err == nil) != c.ok {
			t.Errorf("%s insecure=%v: err=%v, want ok=%v", c.url, c.insecure, err, c.ok)
		}
		if (warn != "") != c.warn {
			t.Errorf("%s insecure=%v: warning=%q, want warn=%v", c.url, c.insecure, warn, c.warn)
		}
	}
}

func TestLoadRefusesInsecureHub(t *testing.T) {
	t.Setenv("HEIMDALL_BOOTSTRAP_TOKEN", "tok")
	t.Setenv("HEIMDALL_HOSTNAME", "fixture-host")
	t.Setenv(AllowInsecureEnv, "")
	t.Setenv("HEIMDALL_HUB_URL", "http://heimdall.example.com:43123")
	_, err := Load(Overrides{Version: "0.0.1"})
	if err == nil || !strings.Contains(err.Error(), AllowInsecureEnv) {
		t.Fatalf("expected insecure refusal naming %s, got %v", AllowInsecureEnv, err)
	}

	t.Setenv(AllowInsecureEnv, "1")
	cfg, err := Load(Overrides{Version: "0.0.1"})
	if err != nil {
		t.Fatalf("Load with %s=1: %v", AllowInsecureEnv, err)
	}
	if len(cfg.Warnings) == 0 {
		t.Fatal("expected an insecure-hub warning")
	}
}
