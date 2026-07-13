package api

import (
	"net/http"
	"time"

	"github.com/go-chi/httprate"

	"github.com/Calmingstorm/bastion/server/internal/auth"
)

func rateLimitedHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "60")
		writeJSON(w, http.StatusTooManyRequests, errorResponse("RATE_LIMITED", "too many requests, please try again later"))
	}
}

// RateLimitByUserID creates rate limiting middleware keyed by authenticated user ID.
// Falls back to resolved-client-IP limiting for unauthenticated requests.
func RateLimitByUserID(requestLimit int, windowLength time.Duration) func(http.Handler) http.Handler {
	return httprate.Limit(
		requestLimit,
		windowLength,
		httprate.WithKeyFuncs(func(r *http.Request) (string, error) {
			userID := auth.UserIDFromContext(r.Context())
			if userID.String() != "00000000-0000-0000-0000-000000000000" {
				return "user:" + userID.String(), nil
			}
			return "ip:" + ClientIP(r).String(), nil
		}),
		httprate.WithLimitHandler(rateLimitedHandler()),
	)
}

// LimitByClientIP rate-limits by the resolved client IP (trusted-proxy aware).
// It replaces httprate.LimitByIP, which keys on the raw socket peer and so would
// collapse every proxied client onto the reverse proxy's address.
func LimitByClientIP(requestLimit int, windowLength time.Duration) func(http.Handler) http.Handler {
	return httprate.Limit(
		requestLimit,
		windowLength,
		httprate.WithKeyFuncs(func(r *http.Request) (string, error) {
			return "ip:" + ClientIP(r).String(), nil
		}),
		httprate.WithLimitHandler(rateLimitedHandler()),
	)
}
