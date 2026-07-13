package api

import (
	"context"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

type clientIPKeyType struct{}

var clientIPKey clientIPKeyType

// clientIPMiddleware resolves the request's client IP using the trusted-proxy
// chain and stores it in the request context. It never rewrites r.RemoteAddr, so
// the real socket peer is preserved for diagnostics and for any middleware that
// should not consume a proxy-asserted identity.
func clientIPMiddleware(trusted []netip.Prefix) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			addr := resolveClientIP(r, trusted)
			ctx := context.WithValue(r.Context(), clientIPKey, addr)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// ClientIP returns the resolved client IP for the request (set by
// clientIPMiddleware). It falls back to the socket peer if the middleware did not
// run. Use this — never r.RemoteAddr — when keying rate limits or logging the
// caller's address.
func ClientIP(r *http.Request) netip.Addr {
	if a, ok := r.Context().Value(clientIPKey).(netip.Addr); ok && a.IsValid() {
		return a
	}
	return peerAddr(r)
}

// peerAddr parses the socket peer address from r.RemoteAddr, canonicalizing
// IPv4-mapped IPv6. Returns the zero Addr if it cannot be parsed.
func peerAddr(r *http.Request) netip.Addr {
	host := r.RemoteAddr
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	a, err := netip.ParseAddr(strings.TrimSpace(host))
	if err != nil {
		return netip.Addr{}
	}
	return a.Unmap()
}

func isTrusted(a netip.Addr, trusted []netip.Prefix) bool {
	if !a.IsValid() {
		return false
	}
	for _, p := range trusted {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// resolveClientIP determines the client IP under the trusted-proxy model. It
// treats the chain as (X-Forwarded-For..., immediate TCP peer) and returns the
// nearest untrusted address walking right to left. Forwarding headers are honored
// only when the immediate peer is itself a trusted proxy; otherwise the peer is
// the client. Empty or malformed forwarded values fail closed to the peer.
func resolveClientIP(r *http.Request, trusted []netip.Prefix) netip.Addr {
	peer := peerAddr(r)
	if !isTrusted(peer, trusted) {
		return peer
	}

	// Join all X-Forwarded-For header lines, so duplicate headers cannot create
	// ambiguity. X-Forwarded-For takes precedence over X-Real-IP.
	xffLines := r.Header.Values("X-Forwarded-For")
	if len(xffLines) == 0 || strings.TrimSpace(strings.Join(xffLines, "")) == "" {
		// No XFF: X-Real-IP is a single-address fallback.
		if xr := strings.TrimSpace(r.Header.Get("X-Real-IP")); xr != "" {
			if a, err := netip.ParseAddr(xr); err == nil {
				return a.Unmap()
			}
		}
		return peer
	}

	entries := strings.Split(strings.Join(xffLines, ","), ",")
	for i := len(entries) - 1; i >= 0; i-- {
		s := strings.TrimSpace(entries[i])
		a, err := netip.ParseAddr(s)
		if err != nil {
			// Empty or malformed entry: fail closed to the nearest known-good hop.
			return peer
		}
		a = a.Unmap()
		if !isTrusted(a, trusted) {
			return a
		}
	}
	// Every entry in the chain is trusted; use the leftmost asserted address.
	if a, err := netip.ParseAddr(strings.TrimSpace(entries[0])); err == nil {
		return a.Unmap()
	}
	return peer
}
