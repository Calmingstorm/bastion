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
		Host: getEnv("BASTION_HOST", "0.0.0.0"),
		Port: getEnv("BASTION_PORT", "8080"),
		DB: DBConfig{
			Host:     getEnv("BASTION_DB_HOST", "localhost"),
			Port:     getEnv("BASTION_DB_PORT", "5432"),
			Name:     getEnv("BASTION_DB_NAME", "bastion"),
			User:     getEnv("BASTION_DB_USER", "bastion"),
			Password: getEnv("BASTION_DB_PASSWORD", "bastion"),
		},
		JWT: JWTConfig{
			Secret:     getEnv("BASTION_JWT_SECRET", "change-me-in-production"),
			AccessTTL:  parseDuration(getEnv("BASTION_JWT_ACCESS_TTL", "15m")),
			RefreshTTL: parseDuration(getEnv("BASTION_JWT_REFRESH_TTL", "168h")),
		},
		Redis: RedisConfig{
			Host: getEnv("BASTION_REDIS_HOST", "localhost"),
			Port: getEnv("BASTION_REDIS_PORT", "6379"),
		},
	}
}

func getEnv(key, fallback string) string {
	if val, ok := os.LookupEnv(key); ok && val != "" {
		return val
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
