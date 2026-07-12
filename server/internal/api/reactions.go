package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/realtime"
)

type ReactionHandler struct {
	db  *pgxpool.Pool
	hub *realtime.Hub
}

func NewReactionHandler(db *pgxpool.Pool, hub *realtime.Hub) *ReactionHandler {
	return &ReactionHandler{db: db, hub: hub}
}

func (h *ReactionHandler) AddReaction(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	channelID, err := parseUUID(chi.URLParam(r, "channelID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid channel ID"))
		return
	}
	messageID, err := parseUUID(chi.URLParam(r, "messageID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid message ID"))
		return
	}
	emoji := chi.URLParam(r, "emoji")
	if emoji == "" || len(emoji) > 32 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid emoji"))
		return
	}

	// The caller must be a member of the channel (server or DM) before they can
	// react or have their reaction broadcast to other members.
	msgHandler := &MessageHandler{db: h.db, hub: h.hub}
	if !msgHandler.checkChannelAccess(r, channelID, userID) {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you do not have access to this channel"))
		return
	}

	// Verify message is in this channel
	var exists bool
	err = h.db.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2)`,
		messageID, channelID,
	).Scan(&exists)
	if err != nil || !exists {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "message not found"))
		return
	}

	tag, err := h.db.Exec(r.Context(),
		`INSERT INTO message_reactions (message_id, user_id, emoji)
		 VALUES ($1, $2, $3)
		 ON CONFLICT DO NOTHING`,
		messageID, userID, emoji,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to add reaction")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Only broadcast when the reaction was actually added, so a duplicate add
	// (retry, second tab) does not inflate the count on other clients.
	if tag.RowsAffected() > 0 {
		h.hub.BroadcastToChannel(channelID, realtime.Event{
			Type: realtime.EventReactionAdd,
			Data: map[string]string{
				"channelId": channelID.String(),
				"messageId": messageID.String(),
				"userId":    userID.String(),
				"emoji":     emoji,
			},
		})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *ReactionHandler) RemoveReaction(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	channelID, err := parseUUID(chi.URLParam(r, "channelID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid channel ID"))
		return
	}
	messageID, err := parseUUID(chi.URLParam(r, "messageID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid message ID"))
		return
	}
	emoji := chi.URLParam(r, "emoji")
	if emoji == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid emoji"))
		return
	}

	// The caller must be a member of the channel (server or DM).
	msgHandler := &MessageHandler{db: h.db, hub: h.hub}
	if !msgHandler.checkChannelAccess(r, channelID, userID) {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you do not have access to this channel"))
		return
	}

	tag, err := h.db.Exec(r.Context(),
		`DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
		messageID, userID, emoji,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to remove reaction")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Only broadcast when a reaction was actually removed, so a no-op remove does
	// not spuriously decrement the count on other clients.
	if tag.RowsAffected() > 0 {
		h.hub.BroadcastToChannel(channelID, realtime.Event{
			Type: realtime.EventReactionRemove,
			Data: map[string]string{
				"channelId": channelID.String(),
				"messageId": messageID.String(),
				"userId":    userID.String(),
				"emoji":     emoji,
			},
		})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
