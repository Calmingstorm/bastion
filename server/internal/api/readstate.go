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
	// channel cannot be recorded against this one. Its database-assigned seq is
	// the READ WATERMARK: everything at or below it is covered by this ack.
	var msgSeq int64
	if err := h.db.QueryRow(r.Context(),
		`SELECT seq FROM messages WHERE id = $1 AND channel_id = $2`,
		messageID, channelID,
	).Scan(&msgSeq); err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "message not found"))
		return
	}

	// The update is gated on the watermark advancing: a stale acknowledgment
	// (an older message acked after a newer one -- racing devices, a delayed
	// retry) must not move last_message_id/last_read_at/last_read_seq backwards.
	// It records ONLY the watermark; the mention badge is computed from the
	// mentions table (COUNT above last_read_seq), so advancing the watermark
	// clears exactly the mentions it now covers and no others.
	// The gated upsert and the read-back of the committed state run in ONE
	// transaction: a concurrent cascade (channel or user delete) cannot remove
	// the read_states row between them, so the re-read always finds it and the
	// response is a consistent snapshot rather than a spurious 500.
	tx, err := h.db.Begin(r.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to begin ack")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	if _, err = tx.Exec(r.Context(),
		`INSERT INTO read_states (user_id, channel_id, last_message_id, last_read_at, last_read_seq)
		 VALUES ($1, $2, $3, NOW(), $4)
		 ON CONFLICT (user_id, channel_id)
		 DO UPDATE SET last_message_id = $3, last_read_at = NOW(),
		   last_read_seq = $4
		 WHERE COALESCE(read_states.last_read_seq, -1) < $4`,
		userID, channelID, messageID, msgSeq,
	); err != nil {
		log.Error().Err(err).Msg("failed to ack channel")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Return the COMMITTED read state, not a bare status: the update may have
	// no-op'd (a stale/duplicate ack the watermark gate rejected), in which case
	// the response carries the truth already on disk -- a watermark possibly
	// AHEAD of what this ack asked for, and the mention badge computed from the
	// mentions table above that watermark. The client commits this authoritative
	// state instead of optimistically guessing what the ack cleared.
	var rs models.ReadState
	if err := tx.QueryRow(r.Context(),
		`SELECT rs.user_id, rs.channel_id, rs.last_message_id, rs.last_read_at, rs.last_read_seq,
		        (SELECT COUNT(*) FROM mentions m
		         WHERE m.user_id = rs.user_id AND m.channel_id = rs.channel_id
		           AND m.seq > COALESCE(rs.last_read_seq, 0)) AS mention_count
		 FROM read_states rs WHERE rs.user_id = $1 AND rs.channel_id = $2`,
		userID, channelID,
	).Scan(&rs.UserID, &rs.ChannelID, &rs.LastMessageID, &rs.LastReadAt, &rs.LastReadSeq, &rs.MentionCount); err != nil {
		log.Error().Err(err).Msg("failed to read committed read state after ack")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		log.Error().Err(err).Msg("failed to commit ack")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeJSON(w, http.StatusOK, rs)
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

	// mention_count is COMPUTED, not stored: the number of this user's mentions
	// in the channel whose message seq is above the read watermark.
	rows, err := h.db.Query(r.Context(),
		`SELECT rs.user_id, rs.channel_id, rs.last_message_id, rs.last_read_at, rs.last_read_seq,
		        (SELECT COUNT(*) FROM mentions m
		         WHERE m.user_id = rs.user_id AND m.channel_id = rs.channel_id
		           AND m.seq > COALESCE(rs.last_read_seq, 0)) AS mention_count
		 FROM read_states rs WHERE rs.user_id = $1 AND rs.channel_id = ANY($2)`, userID, viewable,
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
			&rs.LastReadAt, &rs.LastReadSeq, &rs.MentionCount); err != nil {
			log.Error().Err(err).Msg("failed to scan read state")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		states = append(states, rs)
	}
	if err := rows.Err(); err != nil {
		log.Error().Err(err).Msg("failed to read read-states")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeJSON(w, http.StatusOK, states)
}
