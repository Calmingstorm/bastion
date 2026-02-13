package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/alexedwards/argon2id"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/models"
	"github.com/Calmingstorm/bastion/server/internal/permissions"
)

type BotHandler struct {
	db *pgxpool.Pool
}

func NewBotHandler(db *pgxpool.Pool) *BotHandler {
	return &BotHandler{db: db}
}

type createBotRequest struct {
	Username    string  `json:"username"`
	Description *string `json:"description,omitempty"`
}

type updateBotRequest struct {
	Username    *string `json:"username,omitempty"`
	Description *string `json:"description,omitempty"`
}

// Create handles POST /api/v1/servers/{serverID}/bots
func (h *BotHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageServer); !ok {
		return
	}

	var req createBotRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	req.Username = strings.TrimSpace(req.Username)
	if req.Username == "" || len(req.Username) > 32 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "username is required and must be 1-32 characters"))
		return
	}

	token, err := generateBotToken()
	if err != nil {
		log.Error().Err(err).Msg("failed to generate bot token")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	tokenHash, err := argon2id.CreateHash(token, argon2id.DefaultParams)
	if err != nil {
		log.Error().Err(err).Msg("failed to hash bot token")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	tokenHint := token[len(token)-8:]

	// Create a user for the bot
	var botUserID uuid.UUID
	err = h.db.QueryRow(r.Context(),
		`INSERT INTO users (username, email, password_hash, is_bot)
		 VALUES ($1, $2, '', TRUE)
		 RETURNING id`,
		req.Username, "bot-"+uuid.New().String()+"@internal",
	).Scan(&botUserID)
	if err != nil {
		log.Error().Err(err).Msg("failed to create bot user")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Add bot user as server member
	_, err = h.db.Exec(r.Context(),
		`INSERT INTO server_members (server_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		serverID, botUserID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to add bot as server member")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	var bot models.Bot
	err = h.db.QueryRow(r.Context(),
		`INSERT INTO bots (server_id, creator_id, user_id, token_hash, token_hint, description)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id, server_id, creator_id, user_id, token_hint, description, created_at, updated_at`,
		serverID, userID, botUserID, tokenHash, tokenHint, req.Description,
	).Scan(&bot.ID, &bot.ServerID, &bot.CreatorID, &bot.UserID,
		&bot.TokenHint, &bot.Description, &bot.CreatedAt, &bot.UpdatedAt)
	if err != nil {
		log.Error().Err(err).Msg("failed to create bot")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	bot.Username = req.Username
	bot.Token = token // Return token only on creation

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditBotCreate, "bot", bot.ID, map[string]string{"username": req.Username}, nil)

	writeJSON(w, http.StatusCreated, bot)
}

// List handles GET /api/v1/servers/{serverID}/bots
func (h *BotHandler) List(w http.ResponseWriter, r *http.Request) {
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
		`SELECT b.id, b.server_id, b.creator_id, b.user_id, u.username, u.avatar_url,
			b.token_hint, b.description, b.created_at, b.updated_at
		 FROM bots b
		 INNER JOIN users u ON u.id = b.user_id
		 WHERE b.server_id = $1
		 ORDER BY b.created_at DESC`, serverID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to list bots")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer rows.Close()

	bots := make([]models.Bot, 0)
	for rows.Next() {
		var bot models.Bot
		if err := rows.Scan(&bot.ID, &bot.ServerID, &bot.CreatorID, &bot.UserID,
			&bot.Username, &bot.AvatarURL, &bot.TokenHint, &bot.Description,
			&bot.CreatedAt, &bot.UpdatedAt); err != nil {
			log.Error().Err(err).Msg("failed to scan bot")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		bots = append(bots, bot)
	}

	writeJSON(w, http.StatusOK, bots)
}

// Get handles GET /api/v1/servers/{serverID}/bots/{botID}
func (h *BotHandler) Get(w http.ResponseWriter, r *http.Request) {
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

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageServer); !ok {
		return
	}

	var bot models.Bot
	err = h.db.QueryRow(r.Context(),
		`SELECT b.id, b.server_id, b.creator_id, b.user_id, u.username, u.avatar_url,
			b.token_hint, b.description, b.created_at, b.updated_at
		 FROM bots b
		 INNER JOIN users u ON u.id = b.user_id
		 WHERE b.id = $1 AND b.server_id = $2`, botID, serverID,
	).Scan(&bot.ID, &bot.ServerID, &bot.CreatorID, &bot.UserID,
		&bot.Username, &bot.AvatarURL, &bot.TokenHint, &bot.Description,
		&bot.CreatedAt, &bot.UpdatedAt)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "bot not found"))
		return
	}

	writeJSON(w, http.StatusOK, bot)
}

// Update handles PATCH /api/v1/servers/{serverID}/bots/{botID}
func (h *BotHandler) Update(w http.ResponseWriter, r *http.Request) {
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

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageServer); !ok {
		return
	}

	var req updateBotRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	// Fetch existing bot
	var bot models.Bot
	err = h.db.QueryRow(r.Context(),
		`SELECT b.id, b.server_id, b.creator_id, b.user_id, u.username, u.avatar_url,
			b.token_hint, b.description, b.created_at, b.updated_at
		 FROM bots b
		 INNER JOIN users u ON u.id = b.user_id
		 WHERE b.id = $1 AND b.server_id = $2`, botID, serverID,
	).Scan(&bot.ID, &bot.ServerID, &bot.CreatorID, &bot.UserID,
		&bot.Username, &bot.AvatarURL, &bot.TokenHint, &bot.Description,
		&bot.CreatedAt, &bot.UpdatedAt)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "bot not found"))
		return
	}

	changes := map[string]any{}

	if req.Username != nil {
		username := strings.TrimSpace(*req.Username)
		if username == "" || len(username) > 32 {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "username must be 1-32 characters"))
			return
		}
		changes["username"] = username
		// Update the bot's user record
		_, err = h.db.Exec(r.Context(),
			`UPDATE users SET username = $1 WHERE id = $2`, username, bot.UserID,
		)
		if err != nil {
			log.Error().Err(err).Msg("failed to update bot username")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		bot.Username = username
	}

	if req.Description != nil {
		changes["description"] = *req.Description
		bot.Description = req.Description
	}

	if len(changes) == 0 {
		writeJSON(w, http.StatusOK, bot)
		return
	}

	err = h.db.QueryRow(r.Context(),
		`UPDATE bots SET description = $1, updated_at = NOW()
		 WHERE id = $2
		 RETURNING updated_at`,
		bot.Description, botID,
	).Scan(&bot.UpdatedAt)
	if err != nil {
		log.Error().Err(err).Msg("failed to update bot")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditBotUpdate, "bot", botID, changes, nil)

	writeJSON(w, http.StatusOK, bot)
}

// Delete handles DELETE /api/v1/servers/{serverID}/bots/{botID}
func (h *BotHandler) Delete(w http.ResponseWriter, r *http.Request) {
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

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageServer); !ok {
		return
	}

	var username string
	err = h.db.QueryRow(r.Context(),
		`SELECT u.username FROM bots b INNER JOIN users u ON u.id = b.user_id
		 WHERE b.id = $1 AND b.server_id = $2`, botID, serverID,
	).Scan(&username)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "bot not found"))
		return
	}

	_, err = h.db.Exec(r.Context(),
		`DELETE FROM bots WHERE id = $1`, botID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to delete bot")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditBotDelete, "bot", botID, map[string]string{"username": username}, nil)

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// RegenerateToken handles POST /api/v1/servers/{serverID}/bots/{botID}/regenerate-token
func (h *BotHandler) RegenerateToken(w http.ResponseWriter, r *http.Request) {
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

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageServer); !ok {
		return
	}

	// Verify bot exists
	var botUserID uuid.UUID
	err = h.db.QueryRow(r.Context(),
		`SELECT user_id FROM bots WHERE id = $1 AND server_id = $2`, botID, serverID,
	).Scan(&botUserID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "bot not found"))
		return
	}

	token, err := generateBotToken()
	if err != nil {
		log.Error().Err(err).Msg("failed to generate bot token")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	tokenHash, err := argon2id.CreateHash(token, argon2id.DefaultParams)
	if err != nil {
		log.Error().Err(err).Msg("failed to hash bot token")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	tokenHint := token[len(token)-8:]

	_, err = h.db.Exec(r.Context(),
		`UPDATE bots SET token_hash = $1, token_hint = $2, updated_at = NOW()
		 WHERE id = $3`,
		tokenHash, tokenHint, botID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to regenerate bot token")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditBotTokenRegenerate, "bot", botID, nil, nil)

	writeJSON(w, http.StatusOK, map[string]string{"token": token})
}
