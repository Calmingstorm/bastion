package config

import (
	"fmt"
	"os"
	"strings"
	"time"
)

type Config struct {
	Host   string
	Port   string
	DB     DBConfig
	JWT    JWTConfig
	Redis  RedisConfig
	Upload UploadConfig
	SMTP   SMTPConfig
	Domain string
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

func Load() *Config {
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
			Secret:     getEnvMulti("change-me-in-production", "BASTION_JWT_SECRET", "JWT_SECRET"),
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
		Domain: getEnvMulti("http://localhost:5173", "BASTION_DOMAIN"),
	}
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
