package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/models"
	"github.com/Calmingstorm/bastion/server/internal/realtime"
)

type MessageHandler struct {
	db  *pgxpool.Pool
	hub *realtime.Hub
}

func NewMessageHandler(db *pgxpool.Pool, hub *realtime.Hub) *MessageHandler {
	return &MessageHandler{db: db, hub: hub}
}

type sendMessageRequest struct {
	Content string `json:"content"`
}

func (h *MessageHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	channelID, err := parseUUID(chi.URLParam(r, "channelID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid channel ID"))
		return
	}

	// Verify the user is a member of the server that owns this channel
	var isMember bool
	err = h.db.QueryRow(r.Context(),
		`SELECT EXISTS(
			SELECT 1 FROM server_members sm
			INNER JOIN channels c ON c.server_id = sm.server_id
			WHERE c.id = $1 AND sm.user_id = $2
		)`, channelID, userID,
	).Scan(&isMember)
	if err != nil {
		log.Error().Err(err).Msg("failed to check channel membership")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}
	if !isMember {
		writeJSON(w, http.StatusForbidden, errorBody("you do not have access to this channel"))
		return
	}

	// Cursor-based pagination: fetch messages before a given message's timestamp
	beforeParam := r.URL.Query().Get("before")
	limit := 50

	var rows pgx.Rows

	baseQuery := `SELECT m.id, m.channel_id, m.content, m.edited_at, m.created_at,
		 u.id, u.username, u.display_name, u.avatar_url
		 FROM messages m
		 INNER JOIN users u ON u.id = m.author_id
		 WHERE m.channel_id = $1`

	if beforeParam != "" {
		beforeID, err := uuid.Parse(beforeParam)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("invalid before cursor"))
			return
		}

		// Get the created_at of the cursor message
		var cursorTime time.Time
		err = h.db.QueryRow(r.Context(),
			`SELECT created_at FROM messages WHERE id = $1`, beforeID,
		).Scan(&cursorTime)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("cursor message not found"))
			return
		}

		rows, err = h.db.Query(r.Context(),
			baseQuery+` AND m.created_at < $2 ORDER BY m.created_at DESC LIMIT $3`,
			channelID, cursorTime, limit,
		)
		if err != nil {
			log.Error().Err(err).Msg("failed to list messages")
			writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
			return
		}
	} else {
		rows, err = h.db.Query(r.Context(),
			baseQuery+` ORDER BY m.created_at DESC LIMIT $2`,
			channelID, limit,
		)
		if err != nil {
			log.Error().Err(err).Msg("failed to list messages")
			writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
			return
		}
	}
	defer rows.Close()

	messages := make([]models.Message, 0)
	for rows.Next() {
		var msg models.Message
		var author models.Author
		if err := rows.Scan(&msg.ID, &msg.ChannelID, &msg.Content, &msg.EditedAt, &msg.CreatedAt,
			&author.ID, &author.Username, &author.DisplayName, &author.AvatarURL); err != nil {
			log.Error().Err(err).Msg("failed to scan message")
			writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
			return
		}
		msg.Author = &author
		messages = append(messages, msg)
	}

	if err := rows.Err(); err != nil {
		log.Error().Err(err).Msg("rows iteration error")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	writeJSON(w, http.StatusOK, messages)
}

func (h *MessageHandler) Send(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	channelID, err := parseUUID(chi.URLParam(r, "channelID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid channel ID"))
		return
	}

	// Verify the user is a member of the server that owns this channel
	var isMember bool
	err = h.db.QueryRow(r.Context(),
		`SELECT EXISTS(
			SELECT 1 FROM server_members sm
			INNER JOIN channels c ON c.server_id = sm.server_id
			WHERE c.id = $1 AND sm.user_id = $2
		)`, channelID, userID,
	).Scan(&isMember)
	if err != nil {
		log.Error().Err(err).Msg("failed to check channel membership")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}
	if !isMember {
		writeJSON(w, http.StatusForbidden, errorBody("you do not have access to this channel"))
		return
	}

	var req sendMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))
		return
	}

	req.Content = strings.TrimSpace(req.Content)
	if req.Content == "" {
		writeJSON(w, http.StatusBadRequest, errorBody("message content cannot be empty"))
		return
	}
	if len(req.Content) > 4000 {
		writeJSON(w, http.StatusBadRequest, errorBody("message content cannot exceed 4000 characters"))
		return
	}

	var msg models.Message
	var author models.Author
	err = h.db.QueryRow(r.Context(),
		`WITH new_msg AS (
			INSERT INTO messages (channel_id, author_id, content)
			VALUES ($1, $2, $3)
			RETURNING id, channel_id, author_id, content, edited_at, created_at
		)
		SELECT m.id, m.channel_id, m.content, m.edited_at, m.created_at,
			   u.id, u.username, u.display_name, u.avatar_url
		FROM new_msg m
		INNER JOIN users u ON u.id = m.author_id`,
		channelID, userID, req.Content,
	).Scan(&msg.ID, &msg.ChannelID, &msg.Content, &msg.EditedAt, &msg.CreatedAt,
		&author.ID, &author.Username, &author.DisplayName, &author.AvatarURL)
	if err != nil {
		log.Error().Err(err).Msg("failed to insert message")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}
	msg.Author = &author

	// Broadcast to WebSocket subscribers
	h.hub.BroadcastToChannel(channelID, realtime.Event{
		Type: realtime.EventMessageCreate,
		Data: msg,
	})

	writeJSON(w, http.StatusCreated, msg)
}
