package config

import "testing"

func TestSecurityWarnings(t *testing.T) {
	cases := []struct {
		name    string
		secret  string
		wantLen int
	}{
		{"default secret", DefaultJWTSecret, 1},
		{"short secret", "tooshort", 1},
		{"strong secret", "a-sufficiently-long-random-secret-0123456789", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := &Config{JWT: JWTConfig{Secret: tc.secret}}
			got := c.SecurityWarnings()
			if len(got) != tc.wantLen {
				t.Fatalf("SecurityWarnings(secret=%q) = %v, want %d warning(s)", tc.secret, got, tc.wantLen)
			}
		})
	}
}
