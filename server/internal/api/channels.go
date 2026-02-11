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

type ChannelHandler struct {
	db  *pgxpool.Pool
	hub *realtime.Hub
}

func NewChannelHandler(db *pgxpool.Pool, hub *realtime.Hub) *ChannelHandler {
	return &ChannelHandler{db: db, hub: hub}
}

type createChannelRequest struct {
	Name  string  `json:"name"`
	Topic *string `json:"topic,omitempty"`
}

type updateChannelRequest struct {
	Name  *string `json:"name,omitempty"`
	Topic *string `json:"topic,omitempty"`
}

// broadcastToServer sends an event to all channels in a server so all connected users see it.
func (h *ChannelHandler) broadcastToServer(r *http.Request, serverID uuid.UUID, event realtime.Event) {
	rows, err := h.db.Query(r.Context(), `SELECT id FROM channels WHERE server_id = $1`, serverID)
	if err != nil {
		log.Error().Err(err).Msg("failed to query server channels for broadcast")
		return
	}
	defer rows.Close()
	for rows.Next() {
		var chID uuid.UUID
		if err := rows.Scan(&chID); err != nil {
			continue
		}
		h.hub.BroadcastToChannel(chID, event)
	}
}

func (h *ChannelHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}

	// Verify membership
	var isMember bool
	err = h.db.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2)`,
		serverID, userID,
	).Scan(&isMember)
	if err != nil {
		log.Error().Err(err).Msg("failed to check membership")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	if !isMember {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you are not a member of this server"))
		return
	}

	rows, err := h.db.Query(r.Context(),
		`SELECT id, server_id, name, topic, type, position, category_id, created_at
		 FROM channels
		 WHERE server_id = $1
		 ORDER BY position ASC, created_at ASC`, serverID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to list channels")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer rows.Close()

	channels := make([]models.Channel, 0)
	for rows.Next() {
		var ch models.Channel
		if err := rows.Scan(&ch.ID, &ch.ServerID, &ch.Name, &ch.Topic, &ch.Type, &ch.Position, &ch.CategoryID, &ch.CreatedAt); err != nil {
			log.Error().Err(err).Msg("failed to scan channel")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		channels = append(channels, ch)
	}

	if err := rows.Err(); err != nil {
		log.Error().Err(err).Msg("rows iteration error")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeJSON(w, http.StatusOK, channels)
}

func (h *ChannelHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}

	// Verify permission to manage channels
	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageChannels); !ok {
		return
	}

	var req createChannelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	req.Name = strings.TrimSpace(strings.ToLower(req.Name))
	req.Name = strings.ReplaceAll(req.Name, " ", "-")

	if req.Name == "" || len(req.Name) > 100 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "channel name must be 1-100 characters"))
		return
	}

	// Get the next position
	var maxPos int
	err = h.db.QueryRow(r.Context(),
		`SELECT COALESCE(MAX(position), -1) FROM channels WHERE server_id = $1`, serverID,
	).Scan(&maxPos)
	if err != nil {
		log.Error().Err(err).Msg("failed to get max position")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	var ch models.Channel
	err = h.db.QueryRow(r.Context(),
		`INSERT INTO channels (server_id, name, topic, position)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id, server_id, name, topic, type, position, category_id, created_at`,
		serverID, req.Name, req.Topic, maxPos+1,
	).Scan(&ch.ID, &ch.ServerID, &ch.Name, &ch.Topic, &ch.Type, &ch.Position, &ch.CategoryID, &ch.CreatedAt)
	if err != nil {
		log.Error().Err(err).Msg("failed to create channel")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Broadcast to all server channels so every connected user sees the new channel
	h.broadcastToServer(r, serverID, realtime.Event{
		Type: realtime.EventChannelCreate,
		Data: ch,
	})

	writeJSON(w, http.StatusCreated, ch)
}

func (h *ChannelHandler) Update(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}
	channelID, err := parseUUID(chi.URLParam(r, "channelID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid channel ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageChannels); !ok {
		return
	}

	var req updateChannelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	// Normalize name if provided
	if req.Name != nil {
		name := strings.TrimSpace(strings.ToLower(*req.Name))
		name = strings.ReplaceAll(name, " ", "-")
		if name == "" || len(name) > 100 {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "channel name must be 1-100 characters"))
			return
		}
		req.Name = &name
	}

	// Build dynamic update
	var ch models.Channel
	if req.Name != nil && req.Topic != nil {
		err = h.db.QueryRow(r.Context(),
			`UPDATE channels SET name = $1, topic = $2 WHERE id = $3 AND server_id = $4
			 RETURNING id, server_id, name, topic, type, position, category_id, created_at`,
			*req.Name, *req.Topic, channelID, serverID,
		).Scan(&ch.ID, &ch.ServerID, &ch.Name, &ch.Topic, &ch.Type, &ch.Position, &ch.CategoryID, &ch.CreatedAt)
	} else if req.Name != nil {
		err = h.db.QueryRow(r.Context(),
			`UPDATE channels SET name = $1 WHERE id = $2 AND server_id = $3
			 RETURNING id, server_id, name, topic, type, position, category_id, created_at`,
			*req.Name, channelID, serverID,
		).Scan(&ch.ID, &ch.ServerID, &ch.Name, &ch.Topic, &ch.Type, &ch.Position, &ch.CategoryID, &ch.CreatedAt)
	} else if req.Topic != nil {
		err = h.db.QueryRow(r.Context(),
			`UPDATE channels SET topic = $1 WHERE id = $2 AND server_id = $3
			 RETURNING id, server_id, name, topic, type, position, category_id, created_at`,
			*req.Topic, channelID, serverID,
		).Scan(&ch.ID, &ch.ServerID, &ch.Name, &ch.Topic, &ch.Type, &ch.Position, &ch.CategoryID, &ch.CreatedAt)
	} else {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "nothing to update"))
		return
	}

	if err != nil {
		log.Error().Err(err).Msg("failed to update channel")
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "channel not found"))
		return
	}

	// Broadcast to all server channels
	h.broadcastToServer(r, serverID, realtime.Event{
		Type: realtime.EventChannelUpdate,
		Data: ch,
	})

	// Audit log
	writeAuditLog(h.db, r.Context(), serverID, userID, "CHANNEL_UPDATE", "channel", channelID, map[string]any{
		"name":  ch.Name,
		"topic": ch.Topic,
	}, nil)

	writeJSON(w, http.StatusOK, ch)
}

func (h *ChannelHandler) Delete(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}
	channelID, err := parseUUID(chi.URLParam(r, "channelID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid channel ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageChannels); !ok {
		return
	}

	// Prevent deleting the last channel
	var channelCount int
	err = h.db.QueryRow(r.Context(),
		`SELECT COUNT(*) FROM channels WHERE server_id = $1`, serverID,
	).Scan(&channelCount)
	if err != nil {
		log.Error().Err(err).Msg("failed to count channels")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	if channelCount <= 1 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "cannot delete the last channel"))
		return
	}

	// Get channel name for audit log before deleting
	var channelName string
	h.db.QueryRow(r.Context(), `SELECT name FROM channels WHERE id = $1 AND server_id = $2`, channelID, serverID).Scan(&channelName)

	// Broadcast BEFORE delete so clients still have the channel context
	h.broadcastToServer(r, serverID, realtime.Event{
		Type: realtime.EventChannelDelete,
		Data: map[string]string{
			"channelId": channelID.String(),
			"serverId":  serverID.String(),
		},
	})

	result, err := h.db.Exec(r.Context(),
		`DELETE FROM channels WHERE id = $1 AND server_id = $2`, channelID, serverID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to delete channel")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	if result.RowsAffected() == 0 {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "channel not found"))
		return
	}

	// Audit log
	writeAuditLog(h.db, r.Context(), serverID, userID, "CHANNEL_DELETE", "channel", channelID, map[string]any{
		"name": channelName,
	}, nil)

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

type reorderEntry struct {
	ID       string `json:"id"`
	Position int    `json:"position"`
}

func (h *ChannelHandler) Reorder(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageChannels); !ok {
		return
	}

	var entries []reorderEntry
	if err := json.NewDecoder(r.Body).Decode(&entries); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	if len(entries) == 0 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "no channels to reorder"))
		return
	}

	tx, err := h.db.Begin(r.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to begin transaction")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer tx.Rollback(r.Context())

	for _, entry := range entries {
		chID, err := uuid.Parse(entry.ID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid channel ID: "+entry.ID))
			return
		}
		_, err = tx.Exec(r.Context(),
			`UPDATE channels SET position = $1 WHERE id = $2 AND server_id = $3`,
			entry.Position, chID, serverID,
		)
		if err != nil {
			log.Error().Err(err).Str("channelID", chID.String()).Msg("failed to update channel position")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		log.Error().Err(err).Msg("failed to commit reorder")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Broadcast channel updates to all server channels
	h.broadcastToServer(r, serverID, realtime.Event{
		Type: realtime.EventChannelUpdate,
		Data: map[string]string{
			"serverId": serverID.String(),
			"type":     "reorder",
		},
	})

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
