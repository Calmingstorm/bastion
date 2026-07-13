package api_test

import (
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"testing"

	"github.com/Calmingstorm/bastion/server/internal/config"
	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

// postLogin sends an (intentionally failing) login with an optional
// X-Forwarded-For header and returns the status code.
func postLogin(t *testing.T, url, xff string) int {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url,
		strings.NewReader(`{"email":"nobody@example.com","password":"wrong"}`))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if xff != "" {
		req.Header.Set("X-Forwarded-For", xff)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}

// TestSpoofedXFFDoesNotBypassRateLimit: with no trusted proxies, a client varying
// X-Forwarded-For per request is still limited by its real socket peer — the
// per-IP auth limit (5/min) is not bypassable.
func TestSpoofedXFFDoesNotBypassRateLimit(t *testing.T) {
	h := testutil.New(t) // default: no trusted proxies
	url := h.URL("/api/v1/auth/login")

	got429 := false
	for i := 0; i < 6; i++ {
		if postLogin(t, url, "203.0.113."+strconv.Itoa(i)) == http.StatusTooManyRequests {
			got429 = true
		}
	}
	if !got429 {
		t.Fatal("spoofed XFF from one peer should still hit the rate limit")
	}
}

// TestTrustedProxySeparatesClientBuckets: behind a trusted proxy, the asserted
// XFF client is used, so one client is limited while a distinct client is not.
func TestTrustedProxySeparatesClientBuckets(t *testing.T) {
	h := testutil.New(t, func(c *config.Config) {
		c.Security.TrustedProxies = []netip.Prefix{
			netip.MustParsePrefix("127.0.0.1/32"),
			netip.MustParsePrefix("::1/128"),
		}
	})
	url := h.URL("/api/v1/auth/login")

	limited := false
	for i := 0; i < 6; i++ {
		if postLogin(t, url, "1.1.1.1") == http.StatusTooManyRequests {
			limited = true
		}
	}
	if !limited {
		t.Fatal("the asserted client should be rate limited once its bucket is exhausted")
	}
	if postLogin(t, url, "2.2.2.2") == http.StatusTooManyRequests {
		t.Fatal("a distinct asserted client must get its own bucket")
	}
}
