package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/models"
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
		writeJSON(w, http.StatusBadRequest, errorBody("invalid channel ID"))
		return
	}

	var req ackRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))
		return
	}

	messageID, err := parseUUID(req.MessageID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid message ID"))
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
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *ReadStateHandler) ListReadStates(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())

	rows, err := h.db.Query(r.Context(),
		`SELECT user_id, channel_id, last_message_id, last_read_at, mention_count
		 FROM read_states WHERE user_id = $1`, userID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to list read states")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}
	defer rows.Close()

	states := make([]models.ReadState, 0)
	for rows.Next() {
		var rs models.ReadState
		if err := rows.Scan(&rs.UserID, &rs.ChannelID, &rs.LastMessageID,
			&rs.LastReadAt, &rs.MentionCount); err != nil {
			log.Error().Err(err).Msg("failed to scan read state")
			writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
			return
		}
		states = append(states, rs)
	}

	writeJSON(w, http.StatusOK, states)
}
