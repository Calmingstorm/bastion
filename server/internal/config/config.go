package config

import (
	"fmt"
	"os"
	"time"
)

type Config struct {
	Host  string
	Port  string
	DB    DBConfig
	JWT   JWTConfig
	Redis RedisConfig
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

func parseDuration(s string) time.Duration {
	d, err := time.ParseDuration(s)
	if err != nil {
		return 15 * time.Minute
	}
	return d
}
