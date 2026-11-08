package handshake

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// SecretStore persists the per-agent secret minted by the hub (see internal/state).
type SecretStore interface {
	Load() (string, error)
	Save(secret string) error
}

type Client struct {
	baseURL    string
	token      string // bootstrap/enrollment token (register, and ingest until a secret exists)
	secret     string // per-agent secret; preferred for ingest once present
	store      SecretStore
	httpClient *http.Client
}

type RegisterRequest struct {
	Token       string `json:"token"`
	Hostname    string `json:"hostname"`
	Version     string `json:"version"`
	AgentSecret string `json:"agentSecret,omitempty"`
}

type RegisterResponse struct {
	AgentID      string `json:"agentId"`
	Hostname     string `json:"hostname"`
	Version      string `json:"version"`
	RegisteredAt string `json:"registeredAt"`
	Protocol     string `json:"protocol"`
	// AgentSecret is set only when the hub minted a new secret.
	AgentSecret string `json:"agentSecret,omitempty"`
}

type HeartbeatResponse struct {
	AgentID    string `json:"agentId"`
	LastSeenAt string `json:"lastSeenAt"`
	Status     string `json:"status"`
}

type HealthResponse struct {
	Status  string `json:"status"`
	Service string `json:"service"`
	Phase   int    `json:"phase"`
}

func NewClient(baseURL, token string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		httpClient: &http.Client{
			// Allow hub alert dispatch (SMTP) a bit of headroom; ingest should
			// still respond quickly after cooldown/timeouts on the hub side.
			Timeout: 30 * time.Second,
		},
	}
}

func (c *Client) Health() (HealthResponse, error) {
	var out HealthResponse
	if err := c.getJSON("/api/v1/health", &out); err != nil {
		return HealthResponse{}, err
	}
	return out, nil
}

func (c *Client) Register(req RegisterRequest) (RegisterResponse, error) {
	var out RegisterResponse
	if req.AgentSecret == "" {
		req.AgentSecret = c.secret
	}
	// Hub answers 201 for a new/upgraded agent and 200 for a re-register with the secret.
	if err := c.postJSON("/api/v1/agents/register", req, &out, http.StatusCreated, http.StatusOK); err != nil {
		return RegisterResponse{}, err
	}
	if out.AgentSecret != "" {
		// Persist before using: a lost secret means a 409 on the next restart.
		if c.store != nil {
			if err := c.store.Save(out.AgentSecret); err != nil {
				return RegisterResponse{}, fmt.Errorf("persist agent secret (set HEIMDALL_STATE_DIR to a writable, persistent dir): %w", err)
			}
		}
		c.secret = out.AgentSecret
	}
	return out, nil
}

func (c *Client) Heartbeat(agentID string) (HeartbeatResponse, error) {
	var out HeartbeatResponse
	payload := map[string]string{"agentId": agentID}
	if err := c.postJSON("/api/v1/agents/heartbeat", payload, &out, http.StatusOK); err != nil {
		return HeartbeatResponse{}, err
	}
	return out, nil
}

func (c *Client) getJSON(path string, out any) error {
	resp, err := c.httpClient.Get(c.baseURL + path)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: status %d: %s", path, resp.StatusCode, string(body))
	}
	return json.Unmarshal(body, out)
}

func (c *Client) postJSON(path string, payload any, out any, wantStatuses ...int) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, c.baseURL+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	// Post-register ingest (and heartbeat) require Bearer; register still uses body token.
	if b := c.bearer(); b != "" && path != "/api/v1/agents/register" {
		req.Header.Set("Authorization", "Bearer "+b)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	want := map[int]struct{}{}
	if len(wantStatuses) == 0 {
		want[http.StatusOK] = struct{}{}
	} else {
		for _, s := range wantStatuses {
			want[s] = struct{}{}
		}
	}
	if _, ok := want[resp.StatusCode]; !ok {
		return fmt.Errorf("POST %s: status %d: %s", path, resp.StatusCode, string(body))
	}
	if out == nil || len(body) == 0 {
		return nil
	}
	return json.Unmarshal(body, out)
}

// UseSecretStore attaches persistent secret storage and loads any stored secret,
// so ingest authenticates with it and register presents it (re-register, no rotation).
func (c *Client) UseSecretStore(s SecretStore) error {
	c.store = s
	secret, err := s.Load()
	if err != nil {
		return fmt.Errorf("load agent secret: %w", err)
	}
	c.secret = secret
	return nil
}

// bearer is the credential for ingest: the per-agent secret when present, else the token.
func (c *Client) bearer() string {
	if c.secret != "" {
		return c.secret
	}
	return c.token
}
