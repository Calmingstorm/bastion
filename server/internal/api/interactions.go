package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/models"
	"github.com/Calmingstorm/bastion/server/internal/permissions"
	"github.com/Calmingstorm/bastion/server/internal/realtime"
)

type InteractionHandler struct {
	db  *pgxpool.Pool
	hub *realtime.Hub
}

func NewInteractionHandler(db *pgxpool.Pool, hub *realtime.Hub) *InteractionHandler {
	return &InteractionHandler{db: db, hub: hub}
}

// validCommandName matches Discord's pattern: lowercase alphanumeric + hyphens, 1-32 chars.
var validCommandName = regexp.MustCompile(`^[a-z0-9_-]{1,32}$`)

// ── Command CRUD ───────────────────────────────────────────────────────

type registerCommandRequest struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	Type        *int                   `json:"type,omitempty"` // 1=CHAT_INPUT (default), 2=USER, 3=MESSAGE
	Options     []models.CommandOption `json:"options,omitempty"`
}

type updateCommandRequest struct {
	Description *string                 `json:"description,omitempty"`
	Options     *[]models.CommandOption `json:"options,omitempty"`
}

// RegisterCommand handles POST /api/v1/servers/{serverID}/bots/{botID}/commands
func (h *InteractionHandler) RegisterCommand(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}
	botID, err := parseUUID(chi.URLParam(r, "botID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid bot ID"))
		return
	}

	// Check permission: bot auth requires the bot belongs to this server
	if auth.IsBotFromContext(r.Context()) {
		var dbBotUserID uuid.UUID
		err := h.db.QueryRow(r.Context(),
			`SELECT user_id FROM bots WHERE id = $1 AND server_id = $2`, botID, serverID,
		).Scan(&dbBotUserID)
		if err != nil || dbBotUserID != userID {
			writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "bot does not belong to this server"))
			return
		}
	} else {
		// User auth: require ManageCommands or ManageServer
		if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageCommands); !ok {
			return
		}
	}

	var req registerCommandRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	req.Name = strings.ToLower(strings.TrimSpace(req.Name))
	if !validCommandName.MatchString(req.Name) {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "name must be 1-32 lowercase alphanumeric characters, hyphens, or underscores"))
		return
	}

	req.Description = strings.TrimSpace(req.Description)
	if len(req.Description) > 100 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "description must be 100 characters or fewer"))
		return
	}

	cmdType := 1
	if req.Type != nil {
		cmdType = *req.Type
		if cmdType < 1 || cmdType > 3 {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "type must be 1 (CHAT_INPUT), 2 (USER), or 3 (MESSAGE)"))
			return
		}
	}

	var optionsJSON []byte
	if len(req.Options) > 0 {
		optionsJSON, _ = json.Marshal(req.Options)
	}

	var cmd models.ApplicationCommand
	err = h.db.QueryRow(r.Context(),
		`INSERT INTO application_commands (server_id, bot_id, type, name, description, options)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id, server_id, bot_id, type, name, description, options, created_at, updated_at`,
		serverID, botID, cmdType, req.Name, req.Description, optionsJSON,
	).Scan(&cmd.ID, &cmd.ServerID, &cmd.BotID, &cmd.Type, &cmd.Name, &cmd.Description,
		&optionsJSON, &cmd.CreatedAt, &cmd.UpdatedAt)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate key") || strings.Contains(err.Error(), "unique") {
			writeJSON(w, http.StatusConflict, errorResponse("CONFLICT", "a command with that name already exists for this bot"))
			return
		}
		log.Error().Err(err).Msg("failed to register command")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	if len(optionsJSON) > 0 {
		json.Unmarshal(optionsJSON, &cmd.Options)
	}

	writeJSON(w, http.StatusCreated, cmd)
}

// ListBotCommands handles GET /api/v1/servers/{serverID}/bots/{botID}/commands
func (h *InteractionHandler) ListBotCommands(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}
	botID, err := parseUUID(chi.URLParam(r, "botID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid bot ID"))
		return
	}

	// Bot auth: verify ownership; user auth: verify membership
	if auth.IsBotFromContext(r.Context()) {
		var dbBotUserID uuid.UUID
		err := h.db.QueryRow(r.Context(),
			`SELECT user_id FROM bots WHERE id = $1 AND server_id = $2`, botID, serverID,
		).Scan(&dbBotUserID)
		if err != nil || dbBotUserID != userID {
			writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "bot does not belong to this server"))
			return
		}
	} else {
		// Any server member can list commands for a specific bot
		var exists bool
		h.db.QueryRow(r.Context(),
			`SELECT EXISTS(SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2)`,
			serverID, userID,
		).Scan(&exists)
		if !exists {
			writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "not a member of this server"))
			return
		}
	}

	rows, err := h.db.Query(r.Context(),
		`SELECT id, server_id, bot_id, type, name, description, options, created_at, updated_at
		 FROM application_commands
		 WHERE server_id = $1 AND bot_id = $2
		 ORDER BY name`, serverID, botID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to list bot commands")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer rows.Close()

	commands := make([]models.ApplicationCommand, 0)
	for rows.Next() {
		var cmd models.ApplicationCommand
		var optionsJSON []byte
		if err := rows.Scan(&cmd.ID, &cmd.ServerID, &cmd.BotID, &cmd.Type, &cmd.Name, &cmd.Description,
			&optionsJSON, &cmd.CreatedAt, &cmd.UpdatedAt); err != nil {
			log.Error().Err(err).Msg("failed to scan command")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		if len(optionsJSON) > 0 {
			json.Unmarshal(optionsJSON, &cmd.Options)
		}
		commands = append(commands, cmd)
	}

	writeJSON(w, http.StatusOK, commands)
}

// UpdateCommand handles PATCH /api/v1/servers/{serverID}/bots/{botID}/commands/{commandID}
func (h *InteractionHandler) UpdateCommand(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}
	botID, err := parseUUID(chi.URLParam(r, "botID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid bot ID"))
		return
	}
	commandID, err := parseUUID(chi.URLParam(r, "commandID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid command ID"))
		return
	}

	if auth.IsBotFromContext(r.Context()) {
		var dbBotUserID uuid.UUID
		err := h.db.QueryRow(r.Context(),
			`SELECT user_id FROM bots WHERE id = $1 AND server_id = $2`, botID, serverID,
		).Scan(&dbBotUserID)
		if err != nil || dbBotUserID != userID {
			writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "bot does not belong to this server"))
			return
		}
	} else {
		if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageCommands); !ok {
			return
		}
	}

	var req updateCommandRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	// Fetch existing command
	var cmd models.ApplicationCommand
	var optionsJSON []byte
	err = h.db.QueryRow(r.Context(),
		`SELECT id, server_id, bot_id, type, name, description, options, created_at, updated_at
		 FROM application_commands
		 WHERE id = $1 AND server_id = $2 AND bot_id = $3`, commandID, serverID, botID,
	).Scan(&cmd.ID, &cmd.ServerID, &cmd.BotID, &cmd.Type, &cmd.Name, &cmd.Description,
		&optionsJSON, &cmd.CreatedAt, &cmd.UpdatedAt)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "command not found"))
		return
	}

	if req.Description != nil {
		desc := strings.TrimSpace(*req.Description)
		if len(desc) > 100 {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "description must be 100 characters or fewer"))
			return
		}
		cmd.Description = desc
	}

	if req.Options != nil {
		optionsJSON, _ = json.Marshal(*req.Options)
	}

	err = h.db.QueryRow(r.Context(),
		`UPDATE application_commands SET description = $1, options = $2, updated_at = NOW()
		 WHERE id = $3
		 RETURNING updated_at`,
		cmd.Description, optionsJSON, commandID,
	).Scan(&cmd.UpdatedAt)
	if err != nil {
		log.Error().Err(err).Msg("failed to update command")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	if len(optionsJSON) > 0 {
		json.Unmarshal(optionsJSON, &cmd.Options)
	}

	writeJSON(w, http.StatusOK, cmd)
}

// DeleteCommand handles DELETE /api/v1/servers/{serverID}/bots/{botID}/commands/{commandID}
func (h *InteractionHandler) DeleteCommand(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}
	botID, err := parseUUID(chi.URLParam(r, "botID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid bot ID"))
		return
	}
	commandID, err := parseUUID(chi.URLParam(r, "commandID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid command ID"))
		return
	}

	if auth.IsBotFromContext(r.Context()) {
		var dbBotUserID uuid.UUID
		err := h.db.QueryRow(r.Context(),
			`SELECT user_id FROM bots WHERE id = $1 AND server_id = $2`, botID, serverID,
		).Scan(&dbBotUserID)
		if err != nil || dbBotUserID != userID {
			writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "bot does not belong to this server"))
			return
		}
	} else {
		if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageCommands); !ok {
			return
		}
	}

	tag, err := h.db.Exec(r.Context(),
		`DELETE FROM application_commands WHERE id = $1 AND server_id = $2 AND bot_id = $3`,
		commandID, serverID, botID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to delete command")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	if tag.RowsAffected() == 0 {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "command not found"))
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// ListServerCommands handles GET /api/v1/servers/{serverID}/commands
func (h *InteractionHandler) ListServerCommands(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}

	// Verify membership
	var isMember bool
	h.db.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2)`,
		serverID, userID,
	).Scan(&isMember)
	if !isMember {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "not a member of this server"))
		return
	}

	rows, err := h.db.Query(r.Context(),
		`SELECT ac.id, ac.server_id, ac.bot_id, ac.type, ac.name, ac.description, ac.options,
		        ac.created_at, ac.updated_at
		 FROM application_commands ac
		 WHERE ac.server_id = $1
		 ORDER BY ac.name`, serverID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to list server commands")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer rows.Close()

	commands := make([]models.ApplicationCommand, 0)
	for rows.Next() {
		var cmd models.ApplicationCommand
		var optionsJSON []byte
		if err := rows.Scan(&cmd.ID, &cmd.ServerID, &cmd.BotID, &cmd.Type, &cmd.Name, &cmd.Description,
			&optionsJSON, &cmd.CreatedAt, &cmd.UpdatedAt); err != nil {
			log.Error().Err(err).Msg("failed to scan command")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		if len(optionsJSON) > 0 {
			json.Unmarshal(optionsJSON, &cmd.Options)
		}
		commands = append(commands, cmd)
	}

	writeJSON(w, http.StatusOK, commands)
}

// ── Interaction Execute ────────────────────────────────────────────────

type executeInteractionRequest struct {
	CommandID string               `json:"commandId"`
	ChannelID string               `json:"channelId"`
	Options   []models.ResolvedOpt `json:"options,omitempty"`
	TargetID  *string              `json:"targetId,omitempty"`
}

// Execute handles POST /api/v1/servers/{serverID}/interactions
func (h *InteractionHandler) Execute(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}

	var req executeInteractionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	commandID, err := parseUUID(req.CommandID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid command ID"))
		return
	}
	channelID, err := parseUUID(req.ChannelID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid channel ID"))
		return
	}

	// Look up command
	var cmd models.ApplicationCommand
	var botID uuid.UUID
	var optionsJSON []byte
	err = h.db.QueryRow(r.Context(),
		`SELECT id, server_id, bot_id, type, name, description, options
		 FROM application_commands
		 WHERE id = $1 AND server_id = $2`,
		commandID, serverID,
	).Scan(&cmd.ID, &cmd.ServerID, &botID, &cmd.Type, &cmd.Name, &cmd.Description, &optionsJSON)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "command not found"))
		return
	}
	cmd.BotID = botID

	// Look up bot's user_id
	var botUserID uuid.UUID
	err = h.db.QueryRow(r.Context(),
		`SELECT user_id FROM bots WHERE id = $1`, botID,
	).Scan(&botUserID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "bot not found"))
		return
	}

	// Generate interaction token
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		log.Error().Err(err).Msg("failed to generate interaction token")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	token := hex.EncodeToString(tokenBytes)

	var resolvedOptsJSON []byte
	if len(req.Options) > 0 {
		resolvedOptsJSON, _ = json.Marshal(req.Options)
	}

	var targetID *uuid.UUID
	if req.TargetID != nil {
		tid, err := parseUUID(*req.TargetID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid target ID"))
			return
		}
		targetID = &tid
	}

	expiresAt := time.Now().Add(15 * time.Minute)

	var interactionID uuid.UUID
	err = h.db.QueryRow(r.Context(),
		`INSERT INTO interaction_tokens (server_id, channel_id, command_id, bot_id, invoker_id, token, options_data, target_id, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 RETURNING id`,
		serverID, channelID, commandID, botID, userID, token, resolvedOptsJSON, targetID, expiresAt,
	).Scan(&interactionID)
	if err != nil {
		log.Error().Err(err).Msg("failed to create interaction token")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Build member info for the invoker
	var member models.MemberWithUser
	err = h.db.QueryRow(r.Context(),
		`SELECT sm.server_id, sm.user_id, u.username, u.display_name, u.avatar_url,
		        sm.nickname, sm.role, u.status, u.is_bot, sm.timed_out_until, sm.joined_at
		 FROM server_members sm
		 INNER JOIN users u ON u.id = sm.user_id
		 WHERE sm.server_id = $1 AND sm.user_id = $2`,
		serverID, userID,
	).Scan(&member.ServerID, &member.UserID, &member.Username, &member.DisplayName,
		&member.AvatarURL, &member.Nickname, &member.Role, &member.Status, &member.IsBot,
		&member.TimedOutUntil, &member.JoinedAt)
	if err != nil {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "not a member of this server"))
		return
	}

	// Build the Interaction payload
	interaction := models.Interaction{
		ID:        interactionID,
		Type:      cmd.Type,
		ServerID:  serverID,
		ChannelID: channelID,
		Member:    &member,
		Command: models.InteractionCmd{
			ID:      cmd.ID,
			Name:    cmd.Name,
			Options: req.Options,
		},
		Token:    token,
		TargetID: targetID,
	}

	// Check if the bot has an active WebSocket connection
	if !h.hub.IsUserOnline(botUserID) {
		// Clean up the token we just created — bot can't receive it
		h.db.Exec(r.Context(), `DELETE FROM interaction_tokens WHERE id = $1`, interactionID)
		log.Warn().
			Str("botUserID", botUserID.String()).
			Str("commandName", cmd.Name).
			Msg("interaction target bot is not connected")
		writeJSON(w, http.StatusServiceUnavailable, errorResponse("BOT_OFFLINE", "the bot is not currently connected"))
		return
	}

	// Send INTERACTION_CREATE to the bot's user
	h.hub.BroadcastToUser(botUserID, realtime.Event{
		Type: realtime.EventInteractionCreate,
		Data: interaction,
	})

	log.Debug().
		Str("botUserID", botUserID.String()).
		Str("commandName", cmd.Name).
		Str("invokerID", userID.String()).
		Msg("dispatched INTERACTION_CREATE to bot")

	w.WriteHeader(http.StatusNoContent)
}

// ── Interaction Callback ───────────────────────────────────────────────

type callbackRequest struct {
	Content   string         `json:"content"`
	Embeds    []models.Embed `json:"embeds,omitempty"`
	Ephemeral bool           `json:"ephemeral,omitempty"`
}

// Callback handles POST /api/v1/interactions/{token}/callback
func (h *InteractionHandler) Callback(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	if token == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "missing token"))
		return
	}

	// Look up the interaction token
	var (
		tokenID   uuid.UUID
		serverID  uuid.UUID
		channelID uuid.UUID
		botID     uuid.UUID
		invokerID uuid.UUID
		expiresAt time.Time
	)
	err := h.db.QueryRow(r.Context(),
		`SELECT id, server_id, channel_id, bot_id, invoker_id, expires_at
		 FROM interaction_tokens WHERE token = $1`,
		token,
	).Scan(&tokenID, &serverID, &channelID, &botID, &invokerID, &expiresAt)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "interaction token not found or already used"))
			return
		}
		log.Error().Err(err).Msg("failed to lookup interaction token")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	if time.Now().After(expiresAt) {
		// Clean up expired token
		h.db.Exec(r.Context(), `DELETE FROM interaction_tokens WHERE id = $1`, tokenID)
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "interaction token has expired"))
		return
	}

	var req callbackRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	req.Content = strings.TrimSpace(req.Content)
	if req.Content == "" && len(req.Embeds) == 0 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "response must have content or embeds"))
		return
	}
	// Apply the same content and embed limits as the other message write paths.
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

	// Get bot's user_id for authoring the message
	var botUserID uuid.UUID
	err = h.db.QueryRow(r.Context(),
		`SELECT user_id FROM bots WHERE id = $1`, botID,
	).Scan(&botUserID)
	if err != nil {
		log.Error().Err(err).Msg("failed to lookup bot user")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	if req.Ephemeral {
		// Build an ephemeral message (NOT stored in DB)
		var author models.Author
		err = h.db.QueryRow(r.Context(),
			`SELECT id, username, display_name, avatar_url, is_bot FROM users WHERE id = $1`,
			botUserID,
		).Scan(&author.ID, &author.Username, &author.DisplayName, &author.AvatarURL, &author.IsBot)
		if err != nil {
			log.Error().Err(err).Msg("failed to lookup bot user for ephemeral message")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}

		ephemeralMsg := map[string]any{
			"id":        uuid.New(),
			"channelId": channelID,
			"author":    author,
			"content":   req.Content,
			"embeds":    req.Embeds,
			"ephemeral": true,
			"createdAt": time.Now().UTC(),
		}

		// Same envelope as every persisted-message broadcast. Ephemeral messages
		// have no seq (nothing is inserted), so clients fall to the time tier.
		h.hub.BroadcastToUser(invokerID, realtime.Event{
			Type: realtime.EventMessageCreate,
			Data: map[string]any{"message": ephemeralMsg, "eventAt": time.Now().UTC()},
		})
	} else {
		// Insert a real message in the database
		var msg models.Message
		var author models.Author
		var embedsJSON []byte
		if len(req.Embeds) > 0 {
			embedsJSON, _ = json.Marshal(req.Embeds)
		}

		err = insertMessageTx(r.Context(), h.db, channelID, func(tx pgx.Tx) error {
			return tx.QueryRow(r.Context(),
				`WITH new_msg AS (
					INSERT INTO messages (channel_id, author_id, content, embeds)
					VALUES ($1, $2, $3, $4)
					RETURNING id, channel_id, author_id, content, edited_at, embeds, created_at, seq
				)
				SELECT m.id, m.channel_id, m.content, m.edited_at, m.created_at, m.seq,
				       u.id, u.username, u.display_name, u.avatar_url, u.is_bot, m.embeds
				FROM new_msg m
				INNER JOIN users u ON u.id = m.author_id`,
				channelID, botUserID, req.Content, embedsJSON,
			).Scan(&msg.ID, &msg.ChannelID, &msg.Content, &msg.EditedAt, &msg.CreatedAt, &msg.Seq,
				&author.ID, &author.Username, &author.DisplayName, &author.AvatarURL, &author.IsBot, &embedsJSON)
		})
		if err != nil {
			log.Error().Err(err).Msg("failed to insert interaction callback message")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		msg.Author = &author
		if len(embedsJSON) > 0 {
			json.Unmarshal(embedsJSON, &msg.Embeds)
		}

		h.hub.BroadcastToChannel(channelID, realtime.Event{
			Type: realtime.EventMessageCreate,
			Data: map[string]any{"message": msg, "eventAt": time.Now().UTC()},
		})
	}

	// Delete the used token
	h.db.Exec(r.Context(), `DELETE FROM interaction_tokens WHERE id = $1`, tokenID)

	w.WriteHeader(http.StatusNoContent)
}
