package config

import (
	"fmt"
	"net/netip"
	"os"
	"strings"
	"time"
)

// DefaultJWTSecret is the fallback signing secret. Running with it is insecure
// because anyone can forge access tokens; SecurityWarnings flags it.
const DefaultJWTSecret = "change-me-in-production"

type Config struct {
	Host        string
	Port        string
	DB          DBConfig
	JWT         JWTConfig
	Redis       RedisConfig
	Upload      UploadConfig
	SMTP        SMTPConfig
	Mailgun     MailgunConfig
	Domain      string
	TenorAPIKey string
	GiphyAPIKey string
	Security    SecurityConfig
}

// SecurityConfig holds security-related settings.
type SecurityConfig struct {
	// TrustedProxies is the set of reverse-proxy source networks whose
	// X-Forwarded-For / X-Real-IP headers may be trusted. Empty means never trust
	// forwarding headers (safe for a directly-exposed server).
	TrustedProxies []netip.Prefix
}

// parseTrustedProxies parses a comma-separated list of CIDR prefixes. Blank
// entries and surrounding whitespace are tolerated; any malformed entry is an
// error, so startup fails closed rather than silently narrowing or broadening
// the trusted-proxy set.
func parseTrustedProxies(raw string) ([]netip.Prefix, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	var prefixes []netip.Prefix
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		p, err := netip.ParsePrefix(part)
		if err != nil {
			return nil, fmt.Errorf("trusted proxy %q: %w", part, err)
		}
		// Canonicalize an IPv4-mapped IPv6 prefix to its IPv4 form so it can match
		// request addresses, which are Unmap-canonicalized. Reject a mask that
		// would leave the mapping prefix ambiguous rather than accept a prefix that
		// silently never matches.
		if p.Addr().Is4In6() {
			if p.Bits() < 96 {
				return nil, fmt.Errorf("trusted proxy %q: IPv4-mapped IPv6 prefix needs a /96 or longer mask", part)
			}
			p = netip.PrefixFrom(p.Addr().Unmap(), p.Bits()-96)
		}
		prefixes = append(prefixes, p.Masked())
	}
	return prefixes, nil
}

type SMTPConfig struct {
	Host     string
	Port     string
	Username string
	Password string
	From     string
}

func (c *SMTPConfig) Enabled() bool {
	return c.Host != "" && c.Username != ""
}

type MailgunConfig struct {
	APIKey string
	Domain string
	From   string
}

func (c *MailgunConfig) Enabled() bool {
	return c.APIKey != "" && c.Domain != ""
}

type DBConfig struct {
	Host     string
	Port     string
	Name     string
	User     string
	Password string
}

type JWTConfig struct {
	Secret     string
	AccessTTL  time.Duration
	RefreshTTL time.Duration
}

type RedisConfig struct {
	Host string
	Port string
}

type UploadConfig struct {
	Dir         string
	MaxFileSize int64
	BaseURL     string
}

func (c *DBConfig) DSN() string {
	return fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=disable",
		c.User, c.Password, c.Host, c.Port, c.Name)
}

func (c *RedisConfig) Addr() string {
	return fmt.Sprintf("%s:%s", c.Host, c.Port)
}

func Load() (*Config, error) {
	trustedProxies, err := parseTrustedProxies(getEnvMulti("", "BASTION_TRUSTED_PROXIES"))
	if err != nil {
		return nil, fmt.Errorf("invalid BASTION_TRUSTED_PROXIES: %w", err)
	}
	return &Config{
		Host: getEnvMulti("0.0.0.0", "BASTION_HOST"),
		Port: getEnvMulti("8080", "BASTION_PORT"),
		DB: DBConfig{
			Host:     getEnvMulti("localhost", "BASTION_DB_HOST", "DB_HOST"),
			Port:     getEnvMulti("5432", "BASTION_DB_PORT", "DB_PORT"),
			Name:     getEnvMulti("bastion", "BASTION_DB_NAME", "DB_NAME"),
			User:     getEnvMulti("bastion", "BASTION_DB_USER", "DB_USER"),
			Password: getEnvMulti("bastion", "BASTION_DB_PASSWORD", "DB_PASSWORD"),
		},
		JWT: JWTConfig{
			Secret:     getEnvMulti(DefaultJWTSecret, "BASTION_JWT_SECRET", "JWT_SECRET"),
			AccessTTL:  parseDuration(getEnvMulti("15m", "BASTION_JWT_ACCESS_TTL", "JWT_ACCESS_TTL")),
			RefreshTTL: parseDuration(getEnvMulti("168h", "BASTION_JWT_REFRESH_TTL", "JWT_REFRESH_TTL")),
		},
		Redis: RedisConfig{
			Host: getEnvMulti("localhost", "BASTION_REDIS_HOST", "REDIS_HOST"),
			Port: getEnvMulti("6379", "BASTION_REDIS_PORT", "REDIS_PORT"),
		},
		Upload: UploadConfig{
			Dir:         getEnvMulti("./uploads", "BASTION_UPLOAD_DIR"),
			MaxFileSize: parseFileSize(getEnvMulti("10MB", "BASTION_UPLOAD_MAX_SIZE")),
			BaseURL:     getEnvMulti("/api/uploads", "BASTION_UPLOAD_BASE_URL"),
		},
		SMTP: SMTPConfig{
			Host:     getEnvMulti("", "BASTION_SMTP_HOST"),
			Port:     getEnvMulti("587", "BASTION_SMTP_PORT"),
			Username: getEnvMulti("", "BASTION_SMTP_USER"),
			Password: getEnvMulti("", "BASTION_SMTP_PASS"),
			From:     getEnvMulti("Bastion <noreply@localhost>", "BASTION_SMTP_FROM"),
		},
		Mailgun: MailgunConfig{
			APIKey: getEnvMulti("", "BASTION_MAILGUN_API_KEY"),
			Domain: getEnvMulti("", "BASTION_MAILGUN_DOMAIN"),
			From:   getEnvMulti("Bastion <noreply@localhost>", "BASTION_MAILGUN_FROM"),
		},
		Domain:      getEnvMulti("http://localhost:5173", "BASTION_DOMAIN"),
		TenorAPIKey: getEnvMulti("", "BASTION_TENOR_API_KEY"),
		GiphyAPIKey: getEnvMulti("", "BASTION_GIPHY_API_KEY"),
		Security:    SecurityConfig{TrustedProxies: trustedProxies},
	}, nil
}

// SecurityWarnings returns human-readable warnings about insecure configuration
// that should be surfaced at startup (e.g. running with the default JWT secret).
func (c *Config) SecurityWarnings() []string {
	var warnings []string
	if c.JWT.Secret == DefaultJWTSecret {
		warnings = append(warnings, "JWT secret is the built-in default; set BASTION_JWT_SECRET to a random value — anyone can forge tokens otherwise")
	} else if len(c.JWT.Secret) < 32 {
		warnings = append(warnings, "JWT secret is shorter than 32 bytes; use a longer random value")
	}
	for _, p := range c.Security.TrustedProxies {
		if p.Bits() == 0 {
			warnings = append(warnings, fmt.Sprintf("trusted proxy %s trusts all sources; anyone can then spoof X-Forwarded-For — use a narrow proxy/container-network CIDR", p))
		}
	}
	return warnings
}

func getEnvMulti(fallback string, keys ...string) string {
	for _, key := range keys {
		if val, ok := os.LookupEnv(key); ok && val != "" {
			return val
		}
	}
	return fallback
}

func parseFileSize(s string) int64 {
	s = strings.TrimSpace(strings.ToUpper(s))
	var multiplier int64 = 1
	if strings.HasSuffix(s, "MB") {
		multiplier = 1024 * 1024
		s = strings.TrimSuffix(s, "MB")
	} else if strings.HasSuffix(s, "KB") {
		multiplier = 1024
		s = strings.TrimSuffix(s, "KB")
	} else if strings.HasSuffix(s, "GB") {
		multiplier = 1024 * 1024 * 1024
		s = strings.TrimSuffix(s, "GB")
	}
	val := int64(0)
	for _, c := range s {
		if c >= '0' && c <= '9' {
			val = val*10 + int64(c-'0')
		}
	}
	if val == 0 {
		return 10 * 1024 * 1024 // default 10MB
	}
	return val * multiplier
}

func parseDuration(s string) time.Duration {
	d, err := time.ParseDuration(s)
	if err != nil {
		return 15 * time.Minute
	}
	return d
}
