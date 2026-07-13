package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
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
	// Resolve the client IP from the trusted-proxy chain into the request context
	// (does NOT rewrite RemoteAddr). Must run before rate limiting and logging.
	r.Use(clientIPMiddleware(cfg.Security.TrustedProxies))
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
	serverHandler := NewServerHandler(db, hub, fileStorage, cfg)
	channelHandler := NewChannelHandler(db, hub)
	messageHandler := NewMessageHandler(db, hub)
	inviteHandler := NewInviteHandler(db, hub)
	userHandler := NewUserHandler(db, rdb, fileStorage, cfg)
	uploadHandler := NewUploadHandler(db, hub, fileStorage, cfg)
	dmHandler := NewDMHandler(db, hub)
	readStateHandler := NewReadStateHandler(db)
	roleHandler := NewRoleHandler(db, rdb, hub)
	categoryHandler := NewCategoryHandler(db, hub)
	moderationHandler := NewModerationHandler(db, rdb, hub)
	reactionHandler := NewReactionHandler(db, hub)
	auditLogHandler := NewAuditLogHandler(db)
	gifHandler := NewGifHandler(cfg)
	searchHandler := NewSearchHandler(db)
	unfurlHandler := NewUnfurlHandler(cfg)
	pinHandler := NewPinHandler(db, hub)
	webhookHandler := NewWebhookHandler(db, hub)
	botHandler := NewBotHandler(db)
	interactionHandler := NewInteractionHandler(db, hub)

	// Backward-compat redirect: /api/* -> /api/v1/*
	r.HandleFunc("/api/*", func(w http.ResponseWriter, r *http.Request) {
		newPath := "/api/v1" + strings.TrimPrefix(r.URL.Path, "/api")
		if r.URL.RawQuery != "" {
			newPath += "?" + r.URL.RawQuery
		}
		http.Redirect(w, r, newPath, http.StatusTemporaryRedirect)
	})

	// All API routes under /api/v1
	r.Route("/api/v1", func(r chi.Router) {
		// Public features endpoint
		r.Get("/features", func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{
				"gifSearch":   cfg.TenorAPIKey != "" || cfg.GiphyAPIKey != "",
				"gifProvider": gifProvider(cfg),
			})
		})

		// Public auth routes with rate limiting
		r.Group(func(r chi.Router) {
			r.Use(LimitByClientIP(5, time.Minute))
			r.Route("/auth", func(r chi.Router) {
				r.Post("/register", authHandler.Register)
				r.Post("/login", authHandler.Login)
				r.Post("/refresh", authHandler.Refresh)
				r.Post("/forgot-password", authHandler.ForgotPassword)
				r.Post("/reset-password", authHandler.ResetPassword)
			})
		})

		// Serve uploaded files (public, UUID-named so unguessable)
		r.Get("/uploads/*", userHandler.ServeUpload)

		// Public webhook execution (rate-limited per webhook)
		r.Group(func(r chi.Router) {
			r.Use(LimitByClientIP(30, time.Minute))
			r.Post("/webhooks/{webhookID}/{token}", webhookHandler.Execute)
		})

		// Interaction callback (authenticated by token in URL, not JWT)
		r.Group(func(r chi.Router) {
			r.Use(LimitByClientIP(30, time.Minute))
			r.Post("/interactions/{token}/callback", interactionHandler.Callback)
		})

		// API documentation (public, no auth)
		r.Get("/docs", ServeAPIDocs)
		r.Get("/docs/openapi.yaml", ServeOpenAPISpec)

		// Protected API routes (with timeout)
		r.Group(func(r chi.Router) {
			r.Use(auth.CombinedAuthMiddleware(cfg.JWT.Secret, db))
			r.Use(middleware.Timeout(30 * time.Second))
			r.Use(RateLimitByUserID(120, time.Minute))

			// Users
			r.Get("/users/me", authHandler.GetMe)
			r.Patch("/users/me", userHandler.UpdateProfile)
			r.Post("/users/me/avatar", userHandler.UploadAvatar)
			r.Get("/users/me/read-states", readStateHandler.ListReadStates)
			r.Get("/users/{userID}", userHandler.GetUser)
			r.Get("/users/search", userHandler.SearchUsers)

			// Account management
			r.Post("/users/me/change-password", userHandler.ChangePassword)
			r.Post("/users/me/change-email", userHandler.ChangeEmail)
			r.Delete("/users/me", userHandler.DeleteAccount)

			// Servers
			r.Route("/servers", func(r chi.Router) {
				r.Post("/", serverHandler.Create)
				r.Get("/", serverHandler.List)
				r.Get("/{id}", serverHandler.Get)
				r.Patch("/{id}", serverHandler.Update)
				r.Delete("/{serverID}", serverHandler.Delete)
				r.Post("/{id}/icon", serverHandler.UploadIcon)
				r.Post("/{id}/join", serverHandler.Join)
				r.Delete("/{serverID}/leave", serverHandler.Leave)

				// Nicknames
				r.Patch("/{serverID}/members/{userID}/nickname", serverHandler.UpdateNickname)

				// Channel reordering
				r.Put("/{serverID}/channels/reorder", channelHandler.Reorder)

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

				// Webhooks
				r.Post("/{serverID}/webhooks", webhookHandler.Create)
				r.Get("/{serverID}/webhooks", webhookHandler.List)
				r.Get("/{serverID}/webhooks/{webhookID}", webhookHandler.Get)
				r.Patch("/{serverID}/webhooks/{webhookID}", webhookHandler.Update)
				r.Delete("/{serverID}/webhooks/{webhookID}", webhookHandler.Delete)
				r.Post("/{serverID}/webhooks/{webhookID}/regenerate-token", webhookHandler.RegenerateToken)

				// Bots
				r.Post("/{serverID}/bots", botHandler.Create)
				r.Get("/{serverID}/bots", botHandler.List)
				r.Get("/{serverID}/bots/{botID}", botHandler.Get)
				r.Patch("/{serverID}/bots/{botID}", botHandler.Update)
				r.Delete("/{serverID}/bots/{botID}", botHandler.Delete)
				r.Post("/{serverID}/bots/{botID}/regenerate-token", botHandler.RegenerateToken)

				// Application commands (nested under bots)
				r.Post("/{serverID}/bots/{botID}/commands", interactionHandler.RegisterCommand)
				r.Get("/{serverID}/bots/{botID}/commands", interactionHandler.ListBotCommands)
				r.Patch("/{serverID}/bots/{botID}/commands/{commandID}", interactionHandler.UpdateCommand)
				r.Delete("/{serverID}/bots/{botID}/commands/{commandID}", interactionHandler.DeleteCommand)

				// Server-wide commands listing and interaction execution
				r.Get("/{serverID}/commands", interactionHandler.ListServerCommands)
				r.Post("/{serverID}/interactions", interactionHandler.Execute)
			})

			// Invites (top-level for join/delete)
			r.Delete("/invites/{inviteID}", inviteHandler.Delete)
			r.Post("/invites/{code}/join", inviteHandler.Join)

			// Messages (with message send rate limit)
			r.Route("/channels/{channelID}/messages", func(r chi.Router) {
				r.Get("/", messageHandler.List)
				r.With(RateLimitByUserID(10, 10*time.Second)).Post("/", messageHandler.Send)
				r.With(RateLimitByUserID(5, time.Minute)).Post("/upload", uploadHandler.SendWithAttachments)
				r.Put("/{messageID}", messageHandler.Edit)
				r.Delete("/{messageID}", messageHandler.Delete)
				r.Put("/{messageID}/reactions/{emoji}", reactionHandler.AddReaction)
				r.Delete("/{messageID}/reactions/{emoji}", reactionHandler.RemoveReaction)
			})

			// Bulk import (bot-only, rate limited)
			r.With(RateLimitByUserID(10, time.Minute)).Post("/channels/{channelID}/import", messageHandler.BulkImport)

			// Pinned messages
			r.Put("/channels/{channelID}/pins/{messageID}", pinHandler.Pin)
			r.Delete("/channels/{channelID}/pins/{messageID}", pinHandler.Unpin)
			r.Get("/channels/{channelID}/pins", pinHandler.List)

			// Read states
			r.Post("/channels/{channelID}/ack", readStateHandler.Ack)

			// GIF search
			r.Get("/gifs/search", gifHandler.Search)
			r.Get("/gifs/trending", gifHandler.Trending)

			// Message search
			r.Get("/search", searchHandler.Search)

			// URL unfurling (resolve Tenor/Giphy share URLs to media URLs)
			r.Get("/unfurl", unfurlHandler.Unfurl)

			// Direct Messages
			r.Post("/dm", dmHandler.CreateOrGet)
			r.Get("/dm", dmHandler.List)
			r.Get("/dm/{channelID}", dmHandler.Get)
			r.Post("/dm/{channelID}/close", dmHandler.Close)
		})

		// WebSocket (protected, NO timeout — connection must stay alive)
		r.Group(func(r chi.Router) {
			r.Use(auth.CombinedAuthMiddleware(cfg.JWT.Secret, db))
			r.Get("/ws", func(w http.ResponseWriter, r *http.Request) {
				userID := auth.UserIDFromContext(r.Context())
				realtime.ServeWS(hub, w, r, userID, db, rdb)
			})
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

			// Log the matched route TEMPLATE, never the raw path: path-bound
			// secrets (webhook and interaction tokens) live in the URL, so logging
			// r.URL.Path would copy them into the application logs. Unmatched
			// requests are logged as "unmatched" rather than their raw path, which
			// could likewise contain a secret.
			event.
				Str("method", r.Method).
				Str("route", routePattern(r)).
				Int("status", status).
				Int("bytes", ww.BytesWritten()).
				Dur("duration", time.Since(start)).
				Str("client_ip", ClientIP(r).String()).
				Str("peer_ip", peerAddr(r).String()).
				Msg("request")
		}()

		next.ServeHTTP(ww, r)
	})
}

// routePattern returns the matched chi route template (e.g.
// "/api/v1/webhooks/{webhookID}/{token}"), so logging never records the raw path
// and its path-bound secrets. Unmatched requests return "unmatched".
func routePattern(r *http.Request) string {
	if rc := chi.RouteContext(r.Context()); rc != nil {
		if p := rc.RoutePattern(); p != "" {
			return p
		}
	}
	return "unmatched"
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

type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func errorResponse(code, msg string) map[string]apiError {
	return map[string]apiError{"error": {Code: code, Message: msg}}
}

func parseUUID(s string) (uuid.UUID, error) {
	id, err := uuid.Parse(s)
	if err != nil {
		return uuid.Nil, fmt.Errorf("invalid UUID: %w", err)
	}
	return id, nil
}

func gifProvider(cfg *config.Config) string {
	if cfg.TenorAPIKey != "" {
		return "tenor"
	}
	if cfg.GiphyAPIKey != "" {
		return "giphy"
	}
	return ""
}
