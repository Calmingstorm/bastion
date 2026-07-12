// Package testutil provides an integration-test harness that exercises the real
// Bastion HTTP API against an ephemeral PostgreSQL database and Redis instance.
//
// Each harness creates its own throwaway database (migrated from scratch) and an
// isolated Redis logical DB, then serves the production chi router via
// httptest.NewServer. Tests talk to it over HTTP exactly like a real client, so
// middleware, auth, routing, and rate limiting are all in the loop.
//
// The harness is gated on the TEST_DATABASE_URL and TEST_REDIS_ADDR environment
// variables. When either is unset, New calls t.Skip — so `go test ./...` stays
// green on machines without the services while CI (which provides them) runs the
// full suite. See the repository README and CI workflow for how to run locally.
package testutil

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	server "github.com/Calmingstorm/bastion/server"
	"github.com/Calmingstorm/bastion/server/internal/api"
	"github.com/Calmingstorm/bastion/server/internal/config"
	"github.com/Calmingstorm/bastion/server/internal/database"
	"github.com/Calmingstorm/bastion/server/internal/realtime"
)

// TestJWTSecret is the signing secret used for all harness-issued tokens.
const TestJWTSecret = "test-jwt-secret-not-for-production-0123456789"

var dbSeq atomic.Int64

// Harness is a running Bastion API backed by a throwaway database and Redis DB.
type Harness struct {
	T      *testing.T
	Server *httptest.Server
	Pool   *pgxpool.Pool
	RDB    *redis.Client
	Hub    *realtime.Hub
	Cfg    *config.Config

	admin  *pgxpool.Pool
	dbName string
}

// New builds a fresh harness or skips the test if the required services are
// absent. The harness is torn down automatically via t.Cleanup.
func New(t *testing.T) *Harness {
	t.Helper()

	baseURL := os.Getenv("TEST_DATABASE_URL")
	redisAddr := os.Getenv("TEST_REDIS_ADDR")
	if baseURL == "" || redisAddr == "" {
		t.Skip("integration test requires TEST_DATABASE_URL and TEST_REDIS_ADDR")
	}

	u, err := url.Parse(baseURL)
	if err != nil {
		t.Fatalf("parse TEST_DATABASE_URL: %v", err)
	}
	pw, _ := u.User.Password()
	baseDB := config.DBConfig{
		Host:     u.Hostname(),
		Port:     u.Port(),
		User:     u.User.Username(),
		Password: pw,
		Name:     "postgres",
	}

	ctx := context.Background()
	admin, err := pgxpool.New(ctx, baseDB.DSN())
	if err != nil {
		t.Fatalf("connect to admin database: %v", err)
	}

	// Unique per-test database so suites are fully isolated and parallel-safe.
	dbName := fmt.Sprintf("bastion_test_%d_%d", os.Getpid(), dbSeq.Add(1))
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{dbName}.Sanitize()); err != nil {
		admin.Close()
		t.Fatalf("create test database: %v", err)
	}

	dbCfg := baseDB
	dbCfg.Name = dbName
	cfg := &config.Config{
		Host: "127.0.0.1",
		Port: "0",
		DB:   dbCfg,
		JWT: config.JWTConfig{
			Secret:     TestJWTSecret,
			AccessTTL:  15 * time.Minute,
			RefreshTTL: 168 * time.Hour,
		},
		Upload: config.UploadConfig{
			Dir:         t.TempDir(),
			MaxFileSize: 10 * 1024 * 1024,
			BaseURL:     "/api/uploads",
		},
		Domain: "http://127.0.0.1",
	}

	pool, err := database.New(cfg)
	if err != nil {
		dropDatabase(admin, dbName)
		admin.Close()
		t.Fatalf("open test pool: %v", err)
	}
	if err := database.RunMigrations(server.MigrationsFS, cfg.DB.DSN()); err != nil {
		pool.Close()
		dropDatabase(admin, dbName)
		admin.Close()
		t.Fatalf("run migrations: %v", err)
	}

	// Isolated Redis logical DB (0-15) per harness; flushed on setup and teardown.
	redisDB := int(dbSeq.Load() % 16)
	rdb := redis.NewClient(&redis.Options{Addr: redisAddr, DB: redisDB})
	if err := rdb.Ping(ctx).Err(); err != nil {
		pool.Close()
		dropDatabase(admin, dbName)
		admin.Close()
		t.Fatalf("connect to test redis: %v", err)
	}
	rdb.FlushDB(ctx)

	hub := realtime.NewHub()
	go hub.Run()

	srv := httptest.NewServer(api.NewRouter(pool, cfg, hub, rdb))

	h := &Harness{T: t, Server: srv, Pool: pool, RDB: rdb, Hub: hub, Cfg: cfg, admin: admin, dbName: dbName}
	t.Cleanup(h.Close)
	return h
}

// Close tears down the harness: stops the server and hub, flushes and closes
// Redis, and drops the throwaway database.
func (h *Harness) Close() {
	if h.Server != nil {
		h.Server.Close()
	}
	if h.Hub != nil {
		h.Hub.Stop()
	}
	if h.RDB != nil {
		h.RDB.FlushDB(context.Background())
		_ = h.RDB.Close()
	}
	if h.Pool != nil {
		h.Pool.Close()
	}
	if h.admin != nil {
		dropDatabase(h.admin, h.dbName)
		h.admin.Close()
	}
}

func dropDatabase(admin *pgxpool.Pool, name string) {
	ctx := context.Background()
	// Kick any lingering connections before DROP.
	_, _ = admin.Exec(ctx,
		"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", name)
	_, _ = admin.Exec(ctx, "DROP DATABASE IF EXISTS "+pgx.Identifier{name}.Sanitize())
}

// ---- HTTP helpers ----------------------------------------------------------

// URL returns the absolute URL for an API path (e.g. "/api/v1/users/me").
func (h *Harness) URL(path string) string { return h.Server.URL + path }

// Request issues an HTTP request with a Bearer token (empty token = no auth),
// optional JSON body, and decodes the response body into out when non-nil.
// It returns the HTTP status code.
func (h *Harness) Request(method, path, token string, body, out any) int {
	auth := ""
	if token != "" {
		auth = "Bearer " + token
	}
	return h.RequestAuth(method, path, auth, body, out)
}

// RequestAuth is like Request but takes the full Authorization header value,
// allowing the "Bot <token>" scheme in addition to "Bearer <jwt>".
func (h *Harness) RequestAuth(method, path, authHeader string, body, out any) int {
	h.T.Helper()

	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			h.T.Fatalf("marshal request body: %v", err)
		}
		reader = bytes.NewReader(b)
	}

	req, err := http.NewRequest(method, h.URL(path), reader)
	if err != nil {
		h.T.Fatalf("build request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if authHeader != "" {
		req.Header.Set("Authorization", authHeader)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.T.Fatalf("%s %s: %v", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if out != nil {
		data, _ := io.ReadAll(resp.Body)
		if len(bytes.TrimSpace(data)) > 0 {
			if err := json.Unmarshal(data, out); err != nil {
				h.T.Fatalf("%s %s: decode response (%d): %v; body=%s", method, path, resp.StatusCode, err, string(data))
			}
		}
	}
	return resp.StatusCode
}

// ---- Domain helpers --------------------------------------------------------

// TestUser is a registered account with live tokens.
type TestUser struct {
	ID           string
	Username     string
	Email        string
	Password     string
	AccessToken  string
	RefreshToken string
}

// Register creates a new account and returns it with fresh tokens. It fails the
// test if registration does not return 201.
func (h *Harness) Register(username string) *TestUser {
	h.T.Helper()
	email := strings.ToLower(username) + "@test.local"
	password := "password12345"

	var out struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		User         struct {
			ID       string `json:"id"`
			Username string `json:"username"`
		} `json:"user"`
	}
	code := h.Request(http.MethodPost, "/api/v1/auth/register", "",
		map[string]string{"username": username, "email": email, "password": password}, &out)
	if code != http.StatusCreated {
		h.T.Fatalf("register %q: expected 201, got %d", username, code)
	}
	return &TestUser{
		ID: out.User.ID, Username: username, Email: email, Password: password,
		AccessToken: out.AccessToken, RefreshToken: out.RefreshToken,
	}
}

// CreateServer creates a server owned by u and returns its ID.
func (h *Harness) CreateServer(u *TestUser, name string) string {
	h.T.Helper()
	var out struct {
		ID string `json:"id"`
	}
	code := h.Request(http.MethodPost, "/api/v1/servers", u.AccessToken, map[string]string{"name": name}, &out)
	if code != http.StatusCreated {
		h.T.Fatalf("create server %q: expected 201, got %d", name, code)
	}
	return out.ID
}

// CreateChannel creates a text channel in a server and returns its ID.
func (h *Harness) CreateChannel(u *TestUser, serverID, name string) string {
	h.T.Helper()
	var out struct {
		ID string `json:"id"`
	}
	code := h.Request(http.MethodPost, "/api/v1/servers/"+serverID+"/channels", u.AccessToken,
		map[string]string{"name": name}, &out)
	if code != http.StatusCreated {
		h.T.Fatalf("create channel %q: expected 201, got %d", name, code)
	}
	return out.ID
}
