package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	server "github.com/Calmingstorm/bastion/server"
	"github.com/Calmingstorm/bastion/server/internal/api"
	"github.com/Calmingstorm/bastion/server/internal/config"
	"github.com/Calmingstorm/bastion/server/internal/database"
	"github.com/Calmingstorm/bastion/server/internal/realtime"
)

func main() {
	// Configure zerolog
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	log.Logger = zerolog.New(zerolog.ConsoleWriter{Out: os.Stderr}).
		With().
		Timestamp().
		Caller().
		Logger()

	// Load configuration
	cfg := config.Load()
	log.Info().
		Str("host", cfg.Host).
		Str("port", cfg.Port).
		Msg("starting bastion server")

	// Connect to database
	pool, err := database.New(cfg)
	if err != nil {
		log.Fatal().Err(err).Msg("failed to connect to database")
	}
	defer pool.Close()

	// Run migrations
	if err := database.RunMigrations(server.MigrationsFS, cfg.DB.DSN()); err != nil {
		log.Fatal().Err(err).Msg("failed to run migrations")
	}

	// Connect to Redis
	rdb, err := database.NewRedis(cfg)
	if err != nil {
		log.Fatal().Err(err).Msg("failed to connect to redis")
	}
	defer rdb.Close()

	// Start WebSocket hub
	hub := realtime.NewHub()
	go hub.Run()
	defer hub.Stop()

	// Periodic cleanup of expired interaction tokens
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			_, err := pool.Exec(context.Background(),
				"DELETE FROM interaction_tokens WHERE expires_at < NOW()")
			if err != nil {
				log.Warn().Err(err).Msg("failed to clean up expired interaction tokens")
			}
		}
	}()

	// Create router
	handler := api.NewRouter(pool, cfg, hub, rdb)

	// Create HTTP server
	addr := fmt.Sprintf("%s:%s", cfg.Host, cfg.Port)
	srv := &http.Server{
		Addr:         addr,
		Handler:      handler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Start server in goroutine
	go func() {
		log.Info().Str("addr", addr).Msg("http server listening")
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal().Err(err).Msg("http server error")
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	sig := <-quit
	log.Info().Str("signal", sig.String()).Msg("shutting down server")

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Fatal().Err(err).Msg("server forced to shutdown")
	}

	log.Info().Msg("server stopped")
}
