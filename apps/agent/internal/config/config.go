package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	HubURL      string
	Token       string
	Hostname    string
	Version     string
	Interval    time.Duration
	WatchMounts []string
	LogPaths    []string
	ClusterID   string
	EnableK8s   bool
}

type Overrides struct {
	HubURL      string
	Token       string
	Hostname    string
	Version     string
	Interval    time.Duration
	WatchMounts string
	LogPaths    string
	ClusterID   string
	EnableK8s   *bool
}

func Load(over Overrides) (Config, error) {
	cfg := Config{
		HubURL:    firstNonEmpty(over.HubURL, os.Getenv("HEIMDALL_HUB_URL"), "http://127.0.0.1:43123"),
		Token:     firstNonEmpty(over.Token, os.Getenv("HEIMDALL_BOOTSTRAP_TOKEN")),
		Hostname:  firstNonEmpty(over.Hostname, os.Getenv("HEIMDALL_HOSTNAME")),
		Version:   over.Version,
		Interval:  over.Interval,
		ClusterID: firstNonEmpty(over.ClusterID, os.Getenv("HEIMDALL_CLUSTER_ID"), "default"),
	}

	if cfg.Hostname == "" {
		host, err := os.Hostname()
		if err != nil {
			return Config{}, fmt.Errorf("resolve hostname: %w", err)
		}
		cfg.Hostname = host
	}

	cfg.HubURL = strings.TrimRight(cfg.HubURL, "/")
	if cfg.HubURL == "" {
		return Config{}, fmt.Errorf("hub URL is required")
	}
	if cfg.Token == "" {
		return Config{}, fmt.Errorf("bootstrap/enrollment token is required: set --token or HEIMDALL_BOOTSTRAP_TOKEN")
	}
	if cfg.Version == "" {
		cfg.Version = "0.0.0"
	}
	if cfg.Interval <= 0 {
		cfg.Interval = parseInterval(os.Getenv("HEIMDALL_INTERVAL"), 10*time.Second)
	}

	watch := firstNonEmpty(over.WatchMounts, os.Getenv("HEIMDALL_WATCH_MOUNTS"), "/,/boot,/var")
	for _, part := range strings.Split(watch, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			cfg.WatchMounts = append(cfg.WatchMounts, part)
		}
	}

	logPaths := firstNonEmpty(over.LogPaths, os.Getenv("HEIMDALL_LOG_PATHS"))
	for _, part := range strings.Split(logPaths, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			cfg.LogPaths = append(cfg.LogPaths, part)
		}
	}

	// Precedence: explicit CLI (--enable-k8s true|false) > env > default false.
	// Empty CLI means "unset" so Compose/env can disable without fighting a
	// historical flag.Bool default of true.
	envK8s := strings.TrimSpace(os.Getenv("HEIMDALL_ENABLE_K8S"))
	if over.EnableK8s != nil {
		cfg.EnableK8s = *over.EnableK8s
	} else if envK8s != "" {
		cfg.EnableK8s = parseBool(envK8s, false)
	} else {
		cfg.EnableK8s = false
	}

	return cfg, nil
}

func parseInterval(raw string, fallback time.Duration) time.Duration {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback
	}
	if d, err := time.ParseDuration(raw); err == nil {
		return d
	}
	if secs, err := strconv.Atoi(raw); err == nil && secs > 0 {
		return time.Duration(secs) * time.Second
	}
	return fallback
}

func parseBool(raw string, fallback bool) bool {
	raw = strings.TrimSpace(strings.ToLower(raw))
	if raw == "" {
		return fallback
	}
	switch raw {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
