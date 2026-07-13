package config

import "testing"

func TestParseTrustedProxies(t *testing.T) {
	t.Run("empty is nil, no error", func(t *testing.T) {
		got, err := parseTrustedProxies("   ")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != nil {
			t.Fatalf("want nil, got %v", got)
		}
	})

	t.Run("parses CIDRs, tolerating whitespace and blank entries", func(t *testing.T) {
		got, err := parseTrustedProxies("127.0.0.1/32, ::1/128 ,,172.18.0.0/16")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(got) != 3 {
			t.Fatalf("want 3 prefixes, got %d (%v)", len(got), got)
		}
	})

	t.Run("malformed entry is an error", func(t *testing.T) {
		if _, err := parseTrustedProxies("127.0.0.1/32,not-a-cidr"); err == nil {
			t.Fatal("expected an error for a malformed CIDR")
		}
	})

	t.Run("a bare IP without mask is an error", func(t *testing.T) {
		// netip.ParsePrefix requires a mask; a bare IP is rejected (fail closed).
		if _, err := parseTrustedProxies("127.0.0.1"); err == nil {
			t.Fatal("expected an error for a CIDR without a mask")
		}
	})
}

func TestLoadFailsOnMalformedTrustedProxies(t *testing.T) {
	t.Setenv("BASTION_TRUSTED_PROXIES", "10.0.0.0/8,garbage")
	if _, err := Load(); err == nil {
		t.Fatal("Load should fail on a malformed BASTION_TRUSTED_PROXIES")
	}
}

func TestLoadParsesTrustedProxies(t *testing.T) {
	t.Setenv("BASTION_TRUSTED_PROXIES", "10.0.0.0/8")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cfg.Security.TrustedProxies) != 1 {
		t.Fatalf("want 1 trusted proxy, got %d", len(cfg.Security.TrustedProxies))
	}
}

func TestSecurityWarningsFlagsOverbroadProxy(t *testing.T) {
	cfg := &Config{JWT: JWTConfig{Secret: "a-sufficiently-long-random-secret-value"}}
	before := len(cfg.SecurityWarnings())
	cfg.Security.TrustedProxies, _ = parseTrustedProxies("0.0.0.0/0")
	if got := len(cfg.SecurityWarnings()); got != before+1 {
		t.Fatalf("expected a warning for 0.0.0.0/0, warnings = %v", cfg.SecurityWarnings())
	}
}
