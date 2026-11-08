package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
)

// AllowInsecureEnv opts in to a plain-http hub URL on a routable host name/IP.
const AllowInsecureEnv = "HEIMDALL_ALLOW_INSECURE"

// CheckHubURL rejects a hub URL that would send the bootstrap token and per-agent
// secret in cleartext across a network. https is always accepted. Plain http is
// accepted for:
//   - loopback (localhost, 127.0.0.0/8, ::1);
//   - in-cluster / container-network names: a single-label host ("hub",
//     "heimdall-hub") or a Kubernetes Service name ending in .svc or .svc.cluster.local;
//   - private-network addresses (RFC 1918, CGNAT, IPv6 ULA) and LAN-only names
//     (.lan, .local, .home.arpa, .internal), which is how most self-hosted hubs run;
//   - anything else only when HEIMDALL_ALLOW_INSECURE=1.
//
// The returned warning is non-empty when plain http is accepted on a non-loopback
// host, so callers can log it.
func CheckHubURL(raw string, allowInsecure bool) (warning string, err error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("hub URL %q is not an absolute http(s) URL", raw)
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
		return "", nil
	case "http":
	default:
		return "", fmt.Errorf("hub URL %q must use https (got scheme %q)", raw, u.Scheme)
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if isLoopback(host) {
		return "", nil
	}
	if isClusterInternal(host) {
		return fmt.Sprintf("hub URL %s is plain http on an in-cluster/container-network name; traffic is not encrypted", raw), nil
	}
	if isPrivateNetwork(host) {
		return fmt.Sprintf("hub URL %s is plain http on a private network; the agent token travels unencrypted (use https if the network is shared)", raw), nil
	}
	if allowInsecure {
		return fmt.Sprintf("hub URL %s is plain http (%s=1); the agent token travels unencrypted", raw, AllowInsecureEnv), nil
	}
	return "", fmt.Errorf("refusing plain-http hub URL %s: use https, or set %s=1 to accept an unencrypted hub on a trusted network", raw, AllowInsecureEnv)
}

func allowInsecureFromEnv() bool {
	return parseBool(os.Getenv(AllowInsecureEnv), false)
}

func isLoopback(host string) bool {
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func isClusterInternal(host string) bool {
	if net.ParseIP(host) != nil {
		return false
	}
	if !strings.Contains(host, ".") {
		return true // single-label: compose service "hub", k8s same-namespace "heimdall-hub"
	}
	return strings.HasSuffix(host, ".svc") || strings.HasSuffix(host, ".svc.cluster.local")
}

var cgnat = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}

func isPrivateNetwork(host string) bool {
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsPrivate() || cgnat.Contains(ip)
	}
	for _, suffix := range []string{".lan", ".local", ".home.arpa", ".internal"} {
		if strings.HasSuffix(host, suffix) {
			return true
		}
	}
	return false
}
