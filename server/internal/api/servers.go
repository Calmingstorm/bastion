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
)

type ServerHandler struct {
	db *pgxpool.Pool
}

func NewServerHandler(db *pgxpool.Pool) *ServerHandler {
	return &ServerHandler{db: db}
}

type createServerRequest struct {
	Name string `json:"name"`
}

func (h *ServerHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())

	var req createServerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))
		return
	}

	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 100 {
		writeJSON(w, http.StatusBadRequest, errorBody("server name must be 1-100 characters"))
		return
	}

	tx, err := h.db.Begin(r.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to begin transaction")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}
	defer tx.Rollback(r.Context())

	// Create server
	var server models.Server
	err = tx.QueryRow(r.Context(),
		`INSERT INTO servers (name, owner_id) VALUES ($1, $2)
		 RETURNING id, name, icon_url, owner_id, created_at`,
		req.Name, userID,
	).Scan(&server.ID, &server.Name, &server.IconURL, &server.OwnerID, &server.CreatedAt)
	if err != nil {
		log.Error().Err(err).Msg("failed to create server")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	// Add creator as member
	_, err = tx.Exec(r.Context(),
		`INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)`,
		server.ID, userID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to add creator as member")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	// Create default #general channel
	_, err = tx.Exec(r.Context(),
		`INSERT INTO channels (server_id, name, topic, position) VALUES ($1, 'general', 'General discussion', 0)`,
		server.ID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to create default channel")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		log.Error().Err(err).Msg("failed to commit transaction")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	writeJSON(w, http.StatusCreated, server)
}

func (h *ServerHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())

	rows, err := h.db.Query(r.Context(),
		`SELECT s.id, s.name, s.icon_url, s.owner_id, s.created_at
		 FROM servers s
		 INNER JOIN server_members sm ON sm.server_id = s.id
		 WHERE sm.user_id = $1
		 ORDER BY s.created_at DESC`, userID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to list servers")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}
	defer rows.Close()

	servers := make([]models.Server, 0)
	for rows.Next() {
		var s models.Server
		if err := rows.Scan(&s.ID, &s.Name, &s.IconURL, &s.OwnerID, &s.CreatedAt); err != nil {
			log.Error().Err(err).Msg("failed to scan server")
			writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
			return
		}
		servers = append(servers, s)
	}

	if err := rows.Err(); err != nil {
		log.Error().Err(err).Msg("rows iteration error")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	writeJSON(w, http.StatusOK, servers)
}

func (h *ServerHandler) Get(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "id"))
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

	var s models.Server
	err = h.db.QueryRow(r.Context(),
		`SELECT id, name, icon_url, owner_id, created_at FROM servers WHERE id = $1`,
		serverID,
	).Scan(&s.ID, &s.Name, &s.IconURL, &s.OwnerID, &s.CreatedAt)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorBody("server not found"))
		return
	}

	writeJSON(w, http.StatusOK, s)
}

func (h *ServerHandler) Join(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "id"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid server ID"))
		return
	}

	// Check server exists
	var exists bool
	err = h.db.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM servers WHERE id = $1)`, serverID,
	).Scan(&exists)
	if err != nil || !exists {
		writeJSON(w, http.StatusNotFound, errorBody("server not found"))
		return
	}

	// Check not already a member
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
	if isMember {
		writeJSON(w, http.StatusConflict, errorBody("already a member of this server"))
		return
	}

	// Add as member
	var member models.ServerMember
	err = h.db.QueryRow(r.Context(),
		`INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)
		 RETURNING server_id, user_id, nickname, role, joined_at`,
		serverID, userID,
	).Scan(&member.ServerID, &member.UserID, &member.Nickname, &member.Role, &member.JoinedAt)
	if err != nil {
		log.Error().Err(err).Msg("failed to join server")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	writeJSON(w, http.StatusCreated, member)
}
