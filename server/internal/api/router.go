package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/config"
	"github.com/Calmingstorm/bastion/server/internal/email"
	"github.com/Calmingstorm/bastion/server/internal/realtime"
	"github.com/Calmingstorm/bastion/server/internal/storage"
)

func NewRouter(db *pgxpool.Pool, cfg *config.Config, hub *realtime.Hub, rdb *redis.Client) http.Handler {
	r := chi.NewRouter()

	// Global middleware
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		ExposedHeaders:   []string{"Link"},
		AllowCredentials: false,
		MaxAge:           300,
	}))
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(zerologMiddleware)
	r.Use(middleware.Recoverer)

	// Health check
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	// Create services
	fileStorage := storage.NewFileStorage(&cfg.Upload)
	var emailSvc *email.Service
	if cfg.Mailgun.Enabled() || cfg.SMTP.Enabled() {
		emailSvc = email.New(&cfg.SMTP, &cfg.Mailgun)
	}

	// Create handlers
	authHandler := NewAuthHandler(db, cfg, rdb, emailSvc)
	serverHandler := NewServerHandler(db, fileStorage, cfg)
	channelHandler := NewChannelHandler(db, hub)
	messageHandler := NewMessageHandler(db, hub)
	inviteHandler := NewInviteHandler(db, hub)
	userHandler := NewUserHandler(db, rdb, fileStorage, cfg)
	uploadHandler := NewUploadHandler(db, hub, fileStorage, cfg)
	dmHandler := NewDMHandler(db, hub)
	readStateHandler := NewReadStateHandler(db)
	roleHandler := NewRoleHandler(db, rdb, hub)
	categoryHandler := NewCategoryHandler(db)
	moderationHandler := NewModerationHandler(db, rdb, hub)
	reactionHandler := NewReactionHandler(db, hub)
	auditLogHandler := NewAuditLogHandler(db)

	// Public routes
	r.Route("/api/auth", func(r chi.Router) {
		r.Post("/register", authHandler.Register)
		r.Post("/login", authHandler.Login)
		r.Post("/refresh", authHandler.Refresh)
		r.Post("/forgot-password", authHandler.ForgotPassword)
		r.Post("/reset-password", authHandler.ResetPassword)
	})

	// Serve uploaded files (public, UUID-named so unguessable)
	r.Get("/api/uploads/*", userHandler.ServeUpload)

	// Protected API routes (with timeout)
	r.Group(func(r chi.Router) {
		r.Use(auth.Middleware(cfg.JWT.Secret))
		r.Use(middleware.Timeout(30 * time.Second))

		// Users
		r.Get("/api/users/me", authHandler.GetMe)
		r.Patch("/api/users/me", userHandler.UpdateProfile)
		r.Post("/api/users/me/avatar", userHandler.UploadAvatar)
		r.Get("/api/users/me/read-states", readStateHandler.ListReadStates)
		r.Get("/api/users/{userID}", userHandler.GetUser)

		// Servers
		r.Route("/api/servers", func(r chi.Router) {
			r.Post("/", serverHandler.Create)
			r.Get("/", serverHandler.List)
			r.Get("/{id}", serverHandler.Get)
			r.Patch("/{id}", serverHandler.Update)
			r.Post("/{id}/icon", serverHandler.UploadIcon)
			r.Post("/{id}/join", serverHandler.Join)

			// Channels (nested under servers)
			r.Get("/{serverID}/channels", channelHandler.List)
			r.Post("/{serverID}/channels", channelHandler.Create)
			r.Patch("/{serverID}/channels/{channelID}", channelHandler.Update)
			r.Delete("/{serverID}/channels/{channelID}", channelHandler.Delete)

			// Channel categories
			r.Get("/{serverID}/categories", categoryHandler.List)
			r.Post("/{serverID}/categories", categoryHandler.Create)
			r.Patch("/{serverID}/categories/{categoryID}", categoryHandler.Update)
			r.Delete("/{serverID}/categories/{categoryID}", categoryHandler.Delete)

			// Roles
			r.Get("/{serverID}/roles", roleHandler.List)
			r.Post("/{serverID}/roles", roleHandler.Create)
			r.Patch("/{serverID}/roles/{roleID}", roleHandler.Update)
			r.Delete("/{serverID}/roles/{roleID}", roleHandler.Delete)
			r.Post("/{serverID}/roles/{roleID}/assign", roleHandler.AssignRole)
			r.Post("/{serverID}/roles/{roleID}/remove", roleHandler.RemoveRole)

			// Permissions
			r.Get("/{serverID}/permissions", roleHandler.GetMemberPermissions)

			// Invites (nested under servers)
			r.Post("/{serverID}/invites", inviteHandler.Create)
			r.Get("/{serverID}/invites", inviteHandler.List)

			// Members
			r.Get("/{serverID}/members", userHandler.GetMembers)

			// Moderation
			r.Post("/{serverID}/kick/{targetID}", moderationHandler.Kick)
			r.Post("/{serverID}/bans/{targetID}", moderationHandler.Ban)
			r.Delete("/{serverID}/bans/{targetID}", moderationHandler.Unban)
			r.Get("/{serverID}/bans", moderationHandler.ListBans)
			r.Post("/{serverID}/timeout/{targetID}", moderationHandler.Timeout)

			// Audit log
			r.Get("/{serverID}/audit-log", auditLogHandler.List)
		})

		// Invites (top-level for join/delete)
		r.Delete("/api/invites/{inviteID}", inviteHandler.Delete)
		r.Post("/api/invites/{code}/join", inviteHandler.Join)

		// Messages
		r.Route("/api/channels/{channelID}/messages", func(r chi.Router) {
			r.Get("/", messageHandler.List)
			r.Post("/", messageHandler.Send)
			r.Post("/upload", uploadHandler.SendWithAttachments)
			r.Put("/{messageID}", messageHandler.Edit)
			r.Delete("/{messageID}", messageHandler.Delete)
			r.Put("/{messageID}/reactions/{emoji}", reactionHandler.AddReaction)
			r.Delete("/{messageID}/reactions/{emoji}", reactionHandler.RemoveReaction)
		})

		// Read states
		r.Post("/api/channels/{channelID}/ack", readStateHandler.Ack)

		// Direct Messages
		r.Post("/api/dm", dmHandler.CreateOrGet)
		r.Get("/api/dm", dmHandler.List)
		r.Get("/api/dm/{channelID}", dmHandler.Get)
	})

	// WebSocket (protected, NO timeout — connection must stay alive)
	r.Group(func(r chi.Router) {
		r.Use(auth.Middleware(cfg.JWT.Secret))
		r.Get("/api/ws", func(w http.ResponseWriter, r *http.Request) {
			userID := auth.UserIDFromContext(r.Context())
			realtime.ServeWS(hub, w, r, userID, db, rdb)
		})
	})

	return r
}

// zerologMiddleware logs each request using zerolog.
func zerologMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)

		defer func() {
			var event *zerolog.Event
			status := ww.Status()
			switch {
			case status >= 500:
				event = log.Error()
			case status >= 400:
				event = log.Warn()
			default:
				event = log.Info()
			}

			event.
				Str("method", r.Method).
				Str("path", r.URL.Path).
				Int("status", status).
				Int("bytes", ww.BytesWritten()).
				Dur("duration", time.Since(start)).
				Str("ip", r.RemoteAddr).
				Msg("request")
		}()

		next.ServeHTTP(ww, r)
	})
}

// Helper functions used across all handlers

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		log.Error().Err(err).Msg("failed to encode json response")
	}
}

func errorBody(msg string) map[string]string {
	return map[string]string{"error": msg}
}

func parseUUID(s string) (uuid.UUID, error) {
	id, err := uuid.Parse(s)
	if err != nil {
		return uuid.Nil, fmt.Errorf("invalid UUID: %w", err)
	}
	return id, nil
}
