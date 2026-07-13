package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/models"
	"github.com/Calmingstorm/bastion/server/internal/permissions"
	"github.com/Calmingstorm/bastion/server/internal/realtime"
)

type ReadStateHandler struct {
	db *pgxpool.Pool
}

func NewReadStateHandler(db *pgxpool.Pool) *ReadStateHandler {
	return &ReadStateHandler{db: db}
}

type ackRequest struct {
	MessageID string `json:"messageId"`
}

func (h *ReadStateHandler) Ack(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	channelID, err := parseUUID(chi.URLParam(r, "channelID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid channel ID"))
		return
	}

	var req ackRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	messageID, err := parseUUID(req.MessageID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid message ID"))
		return
	}

	// The caller must be a member of the channel and able to view it — otherwise
	// an outsider could create read-state rows against arbitrary (hidden) channels.
	msgHandler := &MessageHandler{db: h.db}
	if !msgHandler.checkChannelAccess(r, channelID, userID) {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you do not have access to this channel"))
		return
	}
	if !requireChannelPermission(h.db, w, r, channelID, userID, permissions.ViewChannel) {
		return
	}

	// The acked message must belong to this channel, so a message ID from another
	// channel cannot be recorded against this one.
	var msgExists bool
	if err := h.db.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2)`,
		messageID, channelID,
	).Scan(&msgExists); err != nil || !msgExists {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "message not found"))
		return
	}

	_, err = h.db.Exec(r.Context(),
		`INSERT INTO read_states (user_id, channel_id, last_message_id, last_read_at, mention_count)
		 VALUES ($1, $2, $3, NOW(), 0)
		 ON CONFLICT (user_id, channel_id)
		 DO UPDATE SET last_message_id = $3, last_read_at = NOW(), mention_count = 0`,
		userID, channelID, messageID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to ack channel")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *ReadStateHandler) ListReadStates(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())

	// Only expose read states for channels the user may currently view, so losing
	// access (or leaving a server) does not keep leaking channel IDs and mention
	// counts for hidden channels.
	viewable, err := realtime.ViewableChannelIDs(r.Context(), h.db, userID)
	if err != nil {
		log.Error().Err(err).Msg("failed to resolve viewable channels")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	rows, err := h.db.Query(r.Context(),
		`SELECT user_id, channel_id, last_message_id, last_read_at, mention_count
		 FROM read_states WHERE user_id = $1 AND channel_id = ANY($2)`, userID, viewable,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to list read states")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer rows.Close()

	states := make([]models.ReadState, 0)
	for rows.Next() {
		var rs models.ReadState
		if err := rows.Scan(&rs.UserID, &rs.ChannelID, &rs.LastMessageID,
			&rs.LastReadAt, &rs.MentionCount); err != nil {
			log.Error().Err(err).Msg("failed to scan read state")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		states = append(states, rs)
	}

	writeJSON(w, http.StatusOK, states)
}
