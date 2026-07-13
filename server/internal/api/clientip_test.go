package api

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

func prefixes(cidrs ...string) []netip.Prefix {
	ps := make([]netip.Prefix, 0, len(cidrs))
	for _, c := range cidrs {
		ps = append(ps, netip.MustParsePrefix(c))
	}
	return ps
}

// reqWith builds a request with the given RemoteAddr and X-Forwarded-For lines.
func reqWith(remoteAddr string, xff ...string) *http.Request {
	r := &http.Request{RemoteAddr: remoteAddr, Header: http.Header{}}
	for _, v := range xff {
		r.Header.Add("X-Forwarded-For", v)
	}
	return r
}

func TestResolveClientIP(t *testing.T) {
	tests := []struct {
		name    string
		remote  string
		xff     []string
		realIP  string
		trusted []netip.Prefix
		want    string
	}{
		{
			name:    "empty trust list ignores spoofed XFF",
			remote:  "1.2.3.4:5000",
			xff:     []string{"9.9.9.9"},
			trusted: nil,
			want:    "1.2.3.4",
		},
		{
			name:    "untrusted peer ignores headers even with trusted-looking addrs",
			remote:  "1.2.3.4:5000",
			xff:     []string{"10.0.0.1"},
			trusted: prefixes("10.0.0.0/8"),
			want:    "1.2.3.4",
		},
		{
			name:    "trusted peer accepts a simple XFF client",
			remote:  "10.0.0.1:5000",
			xff:     []string{"1.2.3.4"},
			trusted: prefixes("10.0.0.0/8"),
			want:    "1.2.3.4",
		},
		{
			name:    "trusted multi-proxy chain returns nearest untrusted",
			remote:  "10.0.0.1:5000",
			xff:     []string{"1.2.3.4, 10.0.0.2"},
			trusted: prefixes("10.0.0.0/8"),
			want:    "1.2.3.4",
		},
		{
			name:    "client-prepended fake entries are ignored",
			remote:  "10.0.0.1:5000",
			xff:     []string{"9.9.9.9, 1.2.3.4, 10.0.0.2"},
			trusted: prefixes("10.0.0.0/8"),
			want:    "1.2.3.4",
		},
		{
			name:    "duplicate XFF header lines are joined",
			remote:  "10.0.0.1:5000",
			xff:     []string{"1.2.3.4", "10.0.0.2"},
			trusted: prefixes("10.0.0.0/8"),
			want:    "1.2.3.4",
		},
		{
			name:    "malformed XFF entry fails closed to peer",
			remote:  "10.0.0.1:5000",
			xff:     []string{"1.2.3.4, garbage"},
			trusted: prefixes("10.0.0.0/8"),
			want:    "10.0.0.1",
		},
		{
			name:    "every entry trusted uses leftmost",
			remote:  "10.0.0.1:5000",
			xff:     []string{"10.0.0.5, 10.0.0.2"},
			trusted: prefixes("10.0.0.0/8"),
			want:    "10.0.0.5",
		},
		{
			name:    "XFF wins over X-Real-IP",
			remote:  "10.0.0.1:5000",
			xff:     []string{"1.2.3.4"},
			realIP:  "5.6.7.8",
			trusted: prefixes("10.0.0.0/8"),
			want:    "1.2.3.4",
		},
		{
			name:    "X-Real-IP used when XFF absent",
			remote:  "10.0.0.1:5000",
			realIP:  "5.6.7.8",
			trusted: prefixes("10.0.0.0/8"),
			want:    "5.6.7.8",
		},
		{
			name:    "present-but-empty XFF fails closed, ignores X-Real-IP",
			remote:  "10.0.0.1:5000",
			xff:     []string{"   "},
			realIP:  "5.6.7.8",
			trusted: prefixes("10.0.0.0/8"),
			want:    "10.0.0.1",
		},
		{
			name:    "duplicate empty XFF fields fail closed",
			remote:  "10.0.0.1:5000",
			xff:     []string{"", ""},
			trusted: prefixes("10.0.0.0/8"),
			want:    "10.0.0.1",
		},
		{
			name:    "IPv6 client through trusted IPv6 proxy",
			remote:  "[2001:db8::1]:5000",
			xff:     []string{"2606:4700::1"},
			trusted: prefixes("2001:db8::/32"),
			want:    "2606:4700::1",
		},
		{
			name:    "IPv4-mapped IPv6 XFF is canonicalized",
			remote:  "10.0.0.1:5000",
			xff:     []string{"::ffff:1.2.3.4"},
			trusted: prefixes("10.0.0.0/8"),
			want:    "1.2.3.4",
		},
		{
			name:    "bare IPv4 peer without port",
			remote:  "1.2.3.4",
			trusted: nil,
			want:    "1.2.3.4",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := reqWith(tc.remote, tc.xff...)
			if tc.realIP != "" {
				r.Header.Set("X-Real-IP", tc.realIP)
			}
			got := resolveClientIP(r, tc.trusted)
			if got.String() != tc.want {
				t.Fatalf("resolveClientIP = %s, want %s", got, tc.want)
			}
		})
	}
}

// TestResolveClientIPAmbiguousRealIP: multiple X-Real-IP header lines are
// ambiguous and must fail closed to the peer rather than trust either.
func TestResolveClientIPAmbiguousRealIP(t *testing.T) {
	r := &http.Request{RemoteAddr: "10.0.0.1:5000", Header: http.Header{}}
	r.Header.Add("X-Real-IP", "5.6.7.8")
	r.Header.Add("X-Real-IP", "9.9.9.9")
	if got := resolveClientIP(r, prefixes("10.0.0.0/8")); got.String() != "10.0.0.1" {
		t.Fatalf("ambiguous X-Real-IP: got %s, want 10.0.0.1 (peer)", got)
	}
}

func TestClientIPFallsBackToPeerWithoutMiddleware(t *testing.T) {
	// No middleware ran, so ClientIP falls back to the socket peer.
	r := reqWith("1.2.3.4:9000")
	if got := ClientIP(r); got.String() != "1.2.3.4" {
		t.Fatalf("ClientIP without middleware = %s, want 1.2.3.4", got)
	}
}

// TestRequestLogRecordsClientAndPeerIP: the access log records the resolved
// client IP and, separately, the actual socket peer, so a trust-chain mistake is
// diagnosable rather than hidden.
func TestRequestLogRecordsClientAndPeerIP(t *testing.T) {
	var buf bytes.Buffer
	orig := log.Logger
	log.Logger = zerolog.New(&buf)
	t.Cleanup(func() { log.Logger = orig })

	trusted := prefixes("10.0.0.0/8")
	handler := clientIPMiddleware(trusted)(zerologMiddleware(http.HandlerFunc(
		func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) },
	)))

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.RemoteAddr = "10.0.0.1:5000"
	req.Header.Set("X-Forwarded-For", "1.2.3.4")
	handler.ServeHTTP(httptest.NewRecorder(), req)

	out := buf.String()
	if !strings.Contains(out, `"client_ip":"1.2.3.4"`) {
		t.Fatalf("log missing resolved client_ip: %s", out)
	}
	if !strings.Contains(out, `"peer_ip":"10.0.0.1"`) {
		t.Fatalf("log missing peer_ip: %s", out)
	}
}

// TestRequestLogUsesRoutePatternNotRawPath: the access log must record the route
// template, not the raw path, so path-bound secrets (webhook / interaction
// tokens) never land in the logs.
func TestRequestLogUsesRoutePatternNotRawPath(t *testing.T) {
	var buf bytes.Buffer
	orig := log.Logger
	log.Logger = zerolog.New(&buf)
	t.Cleanup(func() { log.Logger = orig })

	r := chi.NewRouter()
	r.Use(clientIPMiddleware(nil))
	r.Use(zerologMiddleware)
	r.Post("/webhooks/{webhookID}/{token}", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodPost, "/webhooks/abc123/whk_supersecret", nil)
	req.RemoteAddr = "1.2.3.4:5000"
	r.ServeHTTP(httptest.NewRecorder(), req)

	out := buf.String()
	if strings.Contains(out, "whk_supersecret") {
		t.Fatalf("access log leaked the token: %s", out)
	}
	if !strings.Contains(out, `"route":"/webhooks/{webhookID}/{token}"`) {
		t.Fatalf("access log missing route pattern: %s", out)
	}
}
