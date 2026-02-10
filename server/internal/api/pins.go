package api

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/models"
	"github.com/Calmingstorm/bastion/server/internal/permissions"
	"github.com/Calmingstorm/bastion/server/internal/realtime"
)

type PinHandler struct {
	db  *pgxpool.Pool
	hub *realtime.Hub
}

func NewPinHandler(db *pgxpool.Pool, hub *realtime.Hub) *PinHandler {
	return &PinHandler{db: db, hub: hub}
}

// Pin handles PUT /api/channels/{channelID}/pins/{messageID}
func (h *PinHandler) Pin(w http.ResponseWriter, r *http.Request) {
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

	// Look up the channel's server_id to determine permission model
	var serverID *uuid.UUID
	err = h.db.QueryRow(r.Context(),
		`SELECT server_id FROM channels WHERE id = $1`, channelID,
	).Scan(&serverID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorBody("channel not found"))
		return
	}

	// Permission check
	if serverID != nil {
		// Server channel: require ManageMessages permission
		if _, ok := requirePermission(h.db, w, r, *serverID, userID, permissions.ManageMessages); !ok {
			return
		}
	} else {
		// DM channel: allow any participant
		var isParticipant bool
		err = h.db.QueryRow(r.Context(),
			`SELECT EXISTS(SELECT 1 FROM dm_members WHERE channel_id = $1 AND user_id = $2)`,
			channelID, userID,
		).Scan(&isParticipant)
		if err != nil || !isParticipant {
			writeJSON(w, http.StatusForbidden, errorBody("you do not have access to this channel"))
			return
		}
	}

	// Verify message exists and belongs to this channel
	var msgExists bool
	err = h.db.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2)`,
		messageID, channelID,
	).Scan(&msgExists)
	if err != nil || !msgExists {
		writeJSON(w, http.StatusNotFound, errorBody("message not found"))
		return
	}

	// Check pin limit (max 50 per channel)
	var pinCount int
	err = h.db.QueryRow(r.Context(),
		`SELECT COUNT(*) FROM message_pins WHERE channel_id = $1`, channelID,
	).Scan(&pinCount)
	if err != nil {
		log.Error().Err(err).Msg("failed to count pins")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}
	if pinCount >= 50 {
		writeJSON(w, http.StatusBadRequest, errorBody("this channel has reached the maximum of 50 pins"))
		return
	}

	// Insert pin (ON CONFLICT DO NOTHING for idempotency)
	_, err = h.db.Exec(r.Context(),
		`INSERT INTO message_pins (channel_id, message_id, pinned_by)
		 VALUES ($1, $2, $3)
		 ON CONFLICT DO NOTHING`,
		channelID, messageID, userID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to pin message")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	h.hub.BroadcastToChannel(channelID, realtime.Event{
		Type: realtime.EventMessagePin,
		Data: map[string]string{
			"channelId": channelID.String(),
			"messageId": messageID.String(),
			"pinnedBy":  userID.String(),
		},
	})

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// Unpin handles DELETE /api/channels/{channelID}/pins/{messageID}
func (h *PinHandler) Unpin(w http.ResponseWriter, r *http.Request) {
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

	// Look up the channel's server_id to determine permission model
	var serverID *uuid.UUID
	err = h.db.QueryRow(r.Context(),
		`SELECT server_id FROM channels WHERE id = $1`, channelID,
	).Scan(&serverID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorBody("channel not found"))
		return
	}

	// Permission check
	if serverID != nil {
		// Server channel: require ManageMessages permission
		if _, ok := requirePermission(h.db, w, r, *serverID, userID, permissions.ManageMessages); !ok {
			return
		}
	} else {
		// DM channel: allow any participant
		var isParticipant bool
		err = h.db.QueryRow(r.Context(),
			`SELECT EXISTS(SELECT 1 FROM dm_members WHERE channel_id = $1 AND user_id = $2)`,
			channelID, userID,
		).Scan(&isParticipant)
		if err != nil || !isParticipant {
			writeJSON(w, http.StatusForbidden, errorBody("you do not have access to this channel"))
			return
		}
	}

	// Delete the pin
	_, err = h.db.Exec(r.Context(),
		`DELETE FROM message_pins WHERE channel_id = $1 AND message_id = $2`,
		channelID, messageID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to unpin message")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	h.hub.BroadcastToChannel(channelID, realtime.Event{
		Type: realtime.EventMessageUnpin,
		Data: map[string]string{
			"channelId": channelID.String(),
			"messageId": messageID.String(),
		},
	})

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// pinnedMessage is the response type for the List endpoint.
type pinnedMessage struct {
	ID        uuid.UUID  `json:"id"`
	ChannelID uuid.UUID  `json:"channelId"`
	Content   string     `json:"content"`
	EditedAt  *time.Time `json:"editedAt,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
	Author    *models.Author `json:"author"`
	PinnedAt  time.Time  `json:"pinnedAt"`
}

// List handles GET /api/channels/{channelID}/pins
func (h *PinHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	channelID, err := parseUUID(chi.URLParam(r, "channelID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid channel ID"))
		return
	}

	// Verify user has access to this channel (server member or DM participant)
	var hasAccess bool
	err = h.db.QueryRow(r.Context(),
		`SELECT EXISTS(
			SELECT 1 FROM server_members sm
			INNER JOIN channels c ON c.server_id = sm.server_id
			WHERE c.id = $1 AND sm.user_id = $2
			UNION ALL
			SELECT 1 FROM dm_members dm
			WHERE dm.channel_id = $1 AND dm.user_id = $2
		)`, channelID, userID,
	).Scan(&hasAccess)
	if err != nil || !hasAccess {
		writeJSON(w, http.StatusForbidden, errorBody("you do not have access to this channel"))
		return
	}

	// Query pinned messages with author info, ordered by pin date DESC
	rows, err := h.db.Query(r.Context(),
		`SELECT m.id, m.channel_id, m.content, m.edited_at, m.created_at,
			u.id, u.username, u.display_name, u.avatar_url,
			mp.created_at
		 FROM message_pins mp
		 INNER JOIN messages m ON m.id = mp.message_id
		 INNER JOIN users u ON u.id = m.author_id
		 WHERE mp.channel_id = $1
		 ORDER BY mp.created_at DESC
		 LIMIT 50`,
		channelID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to list pinned messages")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}
	defer rows.Close()

	pins := make([]pinnedMessage, 0)
	for rows.Next() {
		var msg pinnedMessage
		var author models.Author
		if err := rows.Scan(&msg.ID, &msg.ChannelID, &msg.Content, &msg.EditedAt, &msg.CreatedAt,
			&author.ID, &author.Username, &author.DisplayName, &author.AvatarURL,
			&msg.PinnedAt); err != nil {
			log.Error().Err(err).Msg("failed to scan pinned message")
			writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
			return
		}
		msg.Author = &author
		pins = append(pins, msg)
	}

	if err := rows.Err(); err != nil {
		log.Error().Err(err).Msg("rows iteration error")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	writeJSON(w, http.StatusOK, pins)
}
