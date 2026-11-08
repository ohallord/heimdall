package handshake

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientRegisterAndHeartbeat(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/health", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(HealthResponse{Status: "ok", Service: "heimdall-hub", Phase: 0})
	})
	mux.HandleFunc("/api/v1/agents/register", func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "" {
			t.Fatalf("register must not send Authorization, got %q", auth)
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(RegisterResponse{
			AgentID:  "agt_test",
			Hostname: "edge-01",
			Version:  "0.0.1",
			Protocol: "heimdall.handshake.v0",
		})
	})
	mux.HandleFunc("/api/v1/agents/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer tok" {
			t.Fatalf("heartbeat Authorization = %q, want Bearer tok", got)
		}
		_ = json.NewEncoder(w).Encode(HeartbeatResponse{
			AgentID:    "agt_test",
			LastSeenAt: "2026-10-20T22:00:00Z",
			Status:     "alive",
		})
	})

	server := httptest.NewServer(mux)
	defer server.Close()

	client := NewClient(server.URL, "tok")
	health, err := client.Health()
	if err != nil {
		t.Fatalf("health: %v", err)
	}
	if health.Status != "ok" {
		t.Fatalf("unexpected health status: %s", health.Status)
	}

	reg, err := client.Register(RegisterRequest{
		Token:    "tok",
		Hostname: "edge-01",
		Version:  "0.0.1",
	})
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if reg.AgentID != "agt_test" {
		t.Fatalf("unexpected agent id: %s", reg.AgentID)
	}

	beat, err := client.Heartbeat(reg.AgentID)
	if err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	if beat.Status != "alive" {
		t.Fatalf("unexpected heartbeat status: %s", beat.Status)
	}
}

type memStore struct{ secret string }

func (m *memStore) Load() (string, error) { return m.secret, nil }
func (m *memStore) Save(s string) error   { m.secret = s; return nil }

func TestClientPersistsMintedSecretAndUsesItAsBearer(t *testing.T) {
	var registerBodies []RegisterRequest
	var beatAuth string
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agents/register", func(w http.ResponseWriter, r *http.Request) {
		var req RegisterRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		registerBodies = append(registerBodies, req)
		w.WriteHeader(http.StatusCreated)
		resp := RegisterResponse{AgentID: "agt_1"}
		if req.AgentSecret == "" {
			resp.AgentSecret = "hda_minted"
		}
		_ = json.NewEncoder(w).Encode(resp)
	})
	mux.HandleFunc("/api/v1/agents/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		beatAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(HeartbeatResponse{Status: "alive"})
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	store := &memStore{}
	c := NewClient(server.URL, "enroll-tok")
	if err := c.UseSecretStore(store); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Register(RegisterRequest{Token: "enroll-tok", Hostname: "h", Version: "1"}); err != nil {
		t.Fatal(err)
	}
	if store.secret != "hda_minted" {
		t.Fatalf("secret not persisted: %q", store.secret)
	}
	if registerBodies[0].AgentSecret != "" {
		t.Fatal("first register must not send a secret")
	}
	if _, err := c.Heartbeat("agt_1"); err != nil {
		t.Fatal(err)
	}
	if beatAuth != "Bearer hda_minted" {
		t.Fatalf("heartbeat auth = %q, want the agent secret", beatAuth)
	}

	// A restarted agent loads the stored secret and presents it on register.
	c2 := NewClient(server.URL, "enroll-tok")
	if err := c2.UseSecretStore(store); err != nil {
		t.Fatal(err)
	}
	if _, err := c2.Register(RegisterRequest{Token: "enroll-tok", Hostname: "h", Version: "1"}); err != nil {
		t.Fatal(err)
	}
	if got := registerBodies[1].AgentSecret; got != "hda_minted" {
		t.Fatalf("re-register secret = %q", got)
	}
}

func TestClientFallsBackToTokenWithoutSecret(t *testing.T) {
	var auth string
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agents/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(HeartbeatResponse{Status: "alive"})
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	if _, err := NewClient(server.URL, "legacy").Heartbeat("a"); err != nil {
		t.Fatal(err)
	}
	if auth != "Bearer legacy" {
		t.Fatalf("auth = %q", auth)
	}
}

type failStore struct{ memStore }

func (*failStore) Save(string) error { return http.ErrAbortHandler }

func TestRegisterFailsIfSecretCannotBePersisted(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agents/register", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(RegisterResponse{AgentID: "a", AgentSecret: "hda_x"})
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	c := NewClient(server.URL, "t")
	_ = c.UseSecretStore(&failStore{})
	if _, err := c.Register(RegisterRequest{Token: "t", Hostname: "h", Version: "1"}); err == nil {
		t.Fatal("expected error when the secret cannot be saved")
	}
}
