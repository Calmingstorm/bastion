package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/models"
	"github.com/Calmingstorm/bastion/server/internal/permissions"
	"github.com/Calmingstorm/bastion/server/internal/realtime"
)

type WebhookHandler struct {
	db  *pgxpool.Pool
	hub *realtime.Hub
}

func NewWebhookHandler(db *pgxpool.Pool, hub *realtime.Hub) *WebhookHandler {
	return &WebhookHandler{db: db, hub: hub}
}

type createWebhookRequest struct {
	Name      string `json:"name"`
	ChannelID string `json:"channelId"`
}

type updateWebhookRequest struct {
	Name      *string `json:"name,omitempty"`
	ChannelID *string `json:"channelId,omitempty"`
}

// Create handles POST /api/v1/servers/{serverID}/webhooks
func (h *WebhookHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageServer); !ok {
		return
	}

	var req createWebhookRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 100 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "name is required and must be 1-100 characters"))
		return
	}

	channelID, err := parseUUID(req.ChannelID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid channel ID"))
		return
	}

	// Verify channel belongs to this server
	var channelServerID uuid.UUID
	err = h.db.QueryRow(r.Context(),
		`SELECT server_id FROM channels WHERE id = $1 AND server_id = $2`, channelID, serverID,
	).Scan(&channelServerID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "channel not found in this server"))
		return
	}

	token, err := generateWebhookToken()
	if err != nil {
		log.Error().Err(err).Msg("failed to generate webhook token")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Create a pseudo-user for this webhook to author messages
	// Username column is varchar(32), so use short prefix + hex UUID (no dashes)
	webhookHex := strings.ReplaceAll(uuid.New().String(), "-", "") // 32 hex chars
	webhookUsername := "wh-" + webhookHex[:29]                     // 3+29 = 32 chars
	var webhookUserID uuid.UUID
	err = h.db.QueryRow(r.Context(),
		`INSERT INTO users (username, email, password_hash, is_bot)
		 VALUES ($1, $2, '', TRUE)
		 RETURNING id`,
		webhookUsername, webhookUsername+"@internal",
	).Scan(&webhookUserID)
	if err != nil {
		log.Error().Err(err).Msg("failed to create webhook user")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	var webhook models.Webhook
	err = h.db.QueryRow(r.Context(),
		`INSERT INTO webhooks (server_id, channel_id, creator_id, name, token, user_id)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id, server_id, channel_id, creator_id, name, avatar_url, token, user_id, created_at, updated_at`,
		serverID, channelID, userID, req.Name, token, webhookUserID,
	).Scan(&webhook.ID, &webhook.ServerID, &webhook.ChannelID, &webhook.CreatorID,
		&webhook.Name, &webhook.AvatarURL, &webhook.Token, &webhook.UserID,
		&webhook.CreatedAt, &webhook.UpdatedAt)
	if err != nil {
		log.Error().Err(err).Msg("failed to create webhook")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditWebhookCreate, "webhook", webhook.ID, map[string]string{"name": req.Name}, nil)

	writeJSON(w, http.StatusCreated, webhook)
}

// List handles GET /api/v1/servers/{serverID}/webhooks
func (h *WebhookHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageServer); !ok {
		return
	}

	rows, err := h.db.Query(r.Context(),
		`SELECT id, server_id, channel_id, creator_id, name, avatar_url, user_id, created_at, updated_at
		 FROM webhooks WHERE server_id = $1 ORDER BY created_at DESC`, serverID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to list webhooks")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer rows.Close()

	webhooks := make([]models.Webhook, 0)
	for rows.Next() {
		var wh models.Webhook
		if err := rows.Scan(&wh.ID, &wh.ServerID, &wh.ChannelID, &wh.CreatorID,
			&wh.Name, &wh.AvatarURL, &wh.UserID, &wh.CreatedAt, &wh.UpdatedAt); err != nil {
			log.Error().Err(err).Msg("failed to scan webhook")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		// Don't expose token in list
		webhooks = append(webhooks, wh)
	}

	writeJSON(w, http.StatusOK, webhooks)
}

// Get handles GET /api/v1/servers/{serverID}/webhooks/{webhookID}
func (h *WebhookHandler) Get(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}
	webhookID, err := parseUUID(chi.URLParam(r, "webhookID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid webhook ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageServer); !ok {
		return
	}

	var wh models.Webhook
	err = h.db.QueryRow(r.Context(),
		`SELECT id, server_id, channel_id, creator_id, name, avatar_url, token, user_id, created_at, updated_at
		 FROM webhooks WHERE id = $1 AND server_id = $2`, webhookID, serverID,
	).Scan(&wh.ID, &wh.ServerID, &wh.ChannelID, &wh.CreatorID,
		&wh.Name, &wh.AvatarURL, &wh.Token, &wh.UserID, &wh.CreatedAt, &wh.UpdatedAt)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "webhook not found"))
		return
	}

	writeJSON(w, http.StatusOK, wh)
}

// Update handles PATCH /api/v1/servers/{serverID}/webhooks/{webhookID}
func (h *WebhookHandler) Update(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}
	webhookID, err := parseUUID(chi.URLParam(r, "webhookID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid webhook ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageServer); !ok {
		return
	}

	var req updateWebhookRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	// Build update query dynamically
	var wh models.Webhook
	err = h.db.QueryRow(r.Context(),
		`SELECT id, server_id, channel_id, creator_id, name, avatar_url, user_id, created_at, updated_at
		 FROM webhooks WHERE id = $1 AND server_id = $2`, webhookID, serverID,
	).Scan(&wh.ID, &wh.ServerID, &wh.ChannelID, &wh.CreatorID,
		&wh.Name, &wh.AvatarURL, &wh.UserID, &wh.CreatedAt, &wh.UpdatedAt)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "webhook not found"))
		return
	}

	changes := map[string]any{}

	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" || len(name) > 100 {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "name must be 1-100 characters"))
			return
		}
		changes["name"] = name
		wh.Name = name
	}

	if req.ChannelID != nil {
		channelID, err := parseUUID(*req.ChannelID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid channel ID"))
			return
		}
		// Verify channel belongs to this server
		var cServerID uuid.UUID
		err = h.db.QueryRow(r.Context(),
			`SELECT server_id FROM channels WHERE id = $1 AND server_id = $2`, channelID, serverID,
		).Scan(&cServerID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "channel not found in this server"))
			return
		}
		changes["channelId"] = channelID.String()
		wh.ChannelID = channelID
	}

	if len(changes) == 0 {
		writeJSON(w, http.StatusOK, wh)
		return
	}

	err = h.db.QueryRow(r.Context(),
		`UPDATE webhooks SET name = $1, channel_id = $2, updated_at = NOW()
		 WHERE id = $3
		 RETURNING updated_at`,
		wh.Name, wh.ChannelID, webhookID,
	).Scan(&wh.UpdatedAt)
	if err != nil {
		log.Error().Err(err).Msg("failed to update webhook")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditWebhookUpdate, "webhook", webhookID, changes, nil)

	writeJSON(w, http.StatusOK, wh)
}

// Delete handles DELETE /api/v1/servers/{serverID}/webhooks/{webhookID}
func (h *WebhookHandler) Delete(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}
	webhookID, err := parseUUID(chi.URLParam(r, "webhookID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid webhook ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageServer); !ok {
		return
	}

	// Get webhook name for audit log
	var name string
	err = h.db.QueryRow(r.Context(),
		`SELECT name FROM webhooks WHERE id = $1 AND server_id = $2`, webhookID, serverID,
	).Scan(&name)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "webhook not found"))
		return
	}

	_, err = h.db.Exec(r.Context(),
		`DELETE FROM webhooks WHERE id = $1`, webhookID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to delete webhook")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditWebhookDelete, "webhook", webhookID, map[string]string{"name": name}, nil)

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// Execute handles POST /api/v1/webhooks/{webhookID}/{token} (public, no auth required)
func (h *WebhookHandler) Execute(w http.ResponseWriter, r *http.Request) {
	webhookID, err := parseUUID(chi.URLParam(r, "webhookID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid webhook ID"))
		return
	}
	token := chi.URLParam(r, "token")
	if token == "" {
		writeJSON(w, http.StatusUnauthorized, errorResponse("UNAUTHORIZED", "missing token"))
		return
	}

	// Look up webhook by ID and validate token
	var wh models.Webhook
	err = h.db.QueryRow(r.Context(),
		`SELECT id, server_id, channel_id, name, avatar_url, token, user_id
		 FROM webhooks WHERE id = $1`, webhookID,
	).Scan(&wh.ID, &wh.ServerID, &wh.ChannelID, &wh.Name, &wh.AvatarURL, &wh.Token, &wh.UserID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "webhook not found"))
		return
	}

	if wh.Token != token {
		writeJSON(w, http.StatusUnauthorized, errorResponse("UNAUTHORIZED", "invalid token"))
		return
	}

	var req struct {
		Content   string         `json:"content"`
		Username  *string        `json:"username,omitempty"`
		AvatarURL *string        `json:"avatarUrl,omitempty"`
		Embeds    []models.Embed `json:"embeds,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	req.Content = strings.TrimSpace(req.Content)
	if req.Content == "" && len(req.Embeds) == 0 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "content or embeds required"))
		return
	}
	if len(req.Content) > 4000 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "content cannot exceed 4000 characters"))
		return
	}
	if len(req.Embeds) > 0 {
		if err := validateEmbeds(req.Embeds); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", err.Error()))
			return
		}
	}

	// Build authorOverride if username or avatar overrides are provided
	var authorOverride *models.AuthorOverride
	if (req.Username != nil && *req.Username != "") || (req.AvatarURL != nil && *req.AvatarURL != "") {
		authorOverride = &models.AuthorOverride{}
		if req.Username != nil && *req.Username != "" {
			authorOverride.Username = *req.Username
		} else {
			authorOverride.Username = wh.Name
		}
		if req.AvatarURL != nil && *req.AvatarURL != "" {
			authorOverride.AvatarURL = *req.AvatarURL
		}
	}

	// Insert message as the webhook's pseudo-user
	var whEmbedsJSON []byte
	if len(req.Embeds) > 0 {
		whEmbedsJSON, _ = json.Marshal(req.Embeds)
	}
	var authorOverrideJSON []byte
	if authorOverride != nil {
		authorOverrideJSON, _ = json.Marshal(authorOverride)
	}

	var msg models.Message
	var msgAuthor models.Author
	var returnedEmbedsJSON, returnedOverrideJSON []byte
	err = h.db.QueryRow(r.Context(),
		`WITH new_msg AS (
			INSERT INTO messages (channel_id, author_id, content, embeds, author_override)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING id, channel_id, author_id, content, edited_at, embeds, author_override, created_at
		)
		SELECT m.id, m.channel_id, m.content, m.edited_at, m.created_at,
			   u.id, u.username, u.display_name, u.avatar_url, u.is_bot, m.embeds, m.author_override
		FROM new_msg m
		INNER JOIN users u ON u.id = m.author_id`,
		wh.ChannelID, wh.UserID, req.Content, whEmbedsJSON, authorOverrideJSON,
	).Scan(&msg.ID, &msg.ChannelID, &msg.Content, &msg.EditedAt, &msg.CreatedAt,
		&msgAuthor.ID, &msgAuthor.Username, &msgAuthor.DisplayName, &msgAuthor.AvatarURL, &msgAuthor.IsBot,
		&returnedEmbedsJSON, &returnedOverrideJSON)
	if err != nil {
		log.Error().Err(err).Msg("failed to insert webhook message")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	if len(returnedEmbedsJSON) > 0 {
		json.Unmarshal(returnedEmbedsJSON, &msg.Embeds)
	}
	if len(returnedOverrideJSON) > 0 {
		json.Unmarshal(returnedOverrideJSON, &msg.AuthorOverride)
	}
	msg.Author = &msgAuthor

	// Broadcast to WebSocket subscribers
	h.hub.BroadcastToChannel(wh.ChannelID, realtime.Event{
		Type: realtime.EventMessageCreate,
		Data: msg,
	})

	writeJSON(w, http.StatusOK, msg)
}
