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
	"github.com/Calmingstorm/bastion/server/internal/permissions"
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

type editMessageRequest struct {
	Content string `json:"content"`
}

func (h *MessageHandler) checkChannelAccess(r *http.Request, channelID, userID uuid.UUID) bool {
	var isMember bool
	err := h.db.QueryRow(r.Context(),
		`SELECT EXISTS(
			SELECT 1 FROM server_members sm
			INNER JOIN channels c ON c.server_id = sm.server_id
			WHERE c.id = $1 AND sm.user_id = $2
			UNION ALL
			SELECT 1 FROM dm_members dm
			WHERE dm.channel_id = $1 AND dm.user_id = $2
		)`, channelID, userID,
	).Scan(&isMember)
	return err == nil && isMember
}

func (h *MessageHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	channelID, err := parseUUID(chi.URLParam(r, "channelID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid channel ID"))
		return
	}

	if !h.checkChannelAccess(r, channelID, userID) {
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

	if !h.checkChannelAccess(r, channelID, userID) {
		writeJSON(w, http.StatusForbidden, errorBody("you do not have access to this channel"))
		return
	}

	// Check if user is timed out in this server
	var serverID *uuid.UUID
	h.db.QueryRow(r.Context(), `SELECT server_id FROM channels WHERE id = $1`, channelID).Scan(&serverID)
	if serverID != nil {
		var timedOutUntil *time.Time
		err := h.db.QueryRow(r.Context(),
			`SELECT timed_out_until FROM server_members WHERE server_id = $1 AND user_id = $2`,
			*serverID, userID,
		).Scan(&timedOutUntil)
		if err == nil && timedOutUntil != nil && timedOutUntil.After(time.Now()) {
			writeJSON(w, http.StatusForbidden, errorBody("you are timed out in this server"))
			return
		}
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

func (h *MessageHandler) Edit(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	channelID, err := parseUUID(chi.URLParam(r, "channelID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid channel ID"))
		return
	}
	messageID, err := parseUUID(chi.URLParam(r, "messageID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid message ID"))
		return
	}

	// Verify message exists and user is the author
	var authorID uuid.UUID
	err = h.db.QueryRow(r.Context(),
		`SELECT author_id FROM messages WHERE id = $1 AND channel_id = $2`,
		messageID, channelID,
	).Scan(&authorID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorBody("message not found"))
		return
	}
	if authorID != userID {
		writeJSON(w, http.StatusForbidden, errorBody("you can only edit your own messages"))
		return
	}

	var req editMessageRequest
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
		`UPDATE messages SET content = $1, edited_at = NOW()
		 WHERE id = $2
		 RETURNING id, channel_id, content, edited_at, created_at,
			(SELECT u.id FROM users u WHERE u.id = author_id),
			(SELECT u.username FROM users u WHERE u.id = author_id),
			(SELECT u.display_name FROM users u WHERE u.id = author_id),
			(SELECT u.avatar_url FROM users u WHERE u.id = author_id)`,
		req.Content, messageID,
	).Scan(&msg.ID, &msg.ChannelID, &msg.Content, &msg.EditedAt, &msg.CreatedAt,
		&author.ID, &author.Username, &author.DisplayName, &author.AvatarURL)
	if err != nil {
		log.Error().Err(err).Msg("failed to update message")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}
	msg.Author = &author

	h.hub.BroadcastToChannel(channelID, realtime.Event{
		Type: realtime.EventMessageUpdate,
		Data: msg,
	})

	writeJSON(w, http.StatusOK, msg)
}

func (h *MessageHandler) Delete(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	channelID, err := parseUUID(chi.URLParam(r, "channelID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid channel ID"))
		return
	}
	messageID, err := parseUUID(chi.URLParam(r, "messageID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid message ID"))
		return
	}

	// Verify message exists, get author and channel's server
	var authorID uuid.UUID
	var serverID *uuid.UUID
	err = h.db.QueryRow(r.Context(),
		`SELECT m.author_id, c.server_id
		 FROM messages m
		 INNER JOIN channels c ON c.id = m.channel_id
		 WHERE m.id = $1 AND m.channel_id = $2`,
		messageID, channelID,
	).Scan(&authorID, &serverID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorBody("message not found"))
		return
	}

	// Allow deletion if author OR has MANAGE_MESSAGES permission
	if authorID != userID {
		if serverID == nil {
			writeJSON(w, http.StatusForbidden, errorBody("you can only delete your own messages"))
			return
		}
		perms, err := getMemberPermissions(h.db, r, *serverID, userID)
		if err != nil || !permissions.Has(perms, permissions.ManageMessages) {
			writeJSON(w, http.StatusForbidden, errorBody("you can only delete your own messages"))
			return
		}
	}

	_, err = h.db.Exec(r.Context(),
		`DELETE FROM messages WHERE id = $1`, messageID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to delete message")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	h.hub.BroadcastToChannel(channelID, realtime.Event{
		Type: realtime.EventMessageDelete,
		Data: map[string]string{
			"channelId": channelID.String(),
			"messageId": messageID.String(),
		},
	})

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
