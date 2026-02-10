package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/models"
	"github.com/Calmingstorm/bastion/server/internal/permissions"
)

type ChannelHandler struct {
	db *pgxpool.Pool
}

func NewChannelHandler(db *pgxpool.Pool) *ChannelHandler {
	return &ChannelHandler{db: db}
}

type createChannelRequest struct {
	Name  string  `json:"name"`
	Topic *string `json:"topic,omitempty"`
}

func (h *ChannelHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid server ID"))
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
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}
	if !isMember {
		writeJSON(w, http.StatusForbidden, errorBody("you are not a member of this server"))
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
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}
	defer rows.Close()

	channels := make([]models.Channel, 0)
	for rows.Next() {
		var ch models.Channel
		if err := rows.Scan(&ch.ID, &ch.ServerID, &ch.Name, &ch.Topic, &ch.Type, &ch.Position, &ch.CategoryID, &ch.CreatedAt); err != nil {
			log.Error().Err(err).Msg("failed to scan channel")
			writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
			return
		}
		channels = append(channels, ch)
	}

	if err := rows.Err(); err != nil {
		log.Error().Err(err).Msg("rows iteration error")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	writeJSON(w, http.StatusOK, channels)
}

func (h *ChannelHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid server ID"))
		return
	}

	// Verify permission to manage channels
	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageChannels); !ok {
		return
	}

	var req createChannelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))
		return
	}

	req.Name = strings.TrimSpace(strings.ToLower(req.Name))
	req.Name = strings.ReplaceAll(req.Name, " ", "-")

	if req.Name == "" || len(req.Name) > 100 {
		writeJSON(w, http.StatusBadRequest, errorBody("channel name must be 1-100 characters"))
		return
	}

	// Get the next position
	var maxPos int
	err = h.db.QueryRow(r.Context(),
		`SELECT COALESCE(MAX(position), -1) FROM channels WHERE server_id = $1`, serverID,
	).Scan(&maxPos)
	if err != nil {
		log.Error().Err(err).Msg("failed to get max position")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
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
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	writeJSON(w, http.StatusCreated, ch)
}
