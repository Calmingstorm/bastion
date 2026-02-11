package api

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/config"
	"github.com/Calmingstorm/bastion/server/internal/models"
	"github.com/Calmingstorm/bastion/server/internal/permissions"
	"github.com/Calmingstorm/bastion/server/internal/realtime"
	"github.com/Calmingstorm/bastion/server/internal/storage"
)

type ServerHandler struct {
	db      *pgxpool.Pool
	hub     *realtime.Hub
	storage *storage.FileStorage
	cfg     *config.Config
}

func NewServerHandler(db *pgxpool.Pool, hub *realtime.Hub, storage *storage.FileStorage, cfg *config.Config) *ServerHandler {
	return &ServerHandler{db: db, hub: hub, storage: storage, cfg: cfg}
}

type createServerRequest struct {
	Name string `json:"name"`
}

func (h *ServerHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())

	var req createServerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 100 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "server name must be 1-100 characters"))
		return
	}

	tx, err := h.db.Begin(r.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to begin transaction")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer tx.Rollback(r.Context())

	// Create server
	var server models.Server
	err = tx.QueryRow(r.Context(),
		`INSERT INTO servers (name, owner_id) VALUES ($1, $2)
		 RETURNING id, name, icon_url, description, owner_id, created_at`,
		req.Name, userID,
	).Scan(&server.ID, &server.Name, &server.IconURL, &server.Description, &server.OwnerID, &server.CreatedAt)
	if err != nil {
		log.Error().Err(err).Msg("failed to create server")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Add creator as owner member
	_, err = tx.Exec(r.Context(),
		`INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'owner')`,
		server.ID, userID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to add creator as member")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Create default @bastion role
	defaultPerms := permissions.ViewChannel | permissions.SendMessages | permissions.CreateInvites | permissions.AttachFiles
	var defaultRoleID string
	err = tx.QueryRow(r.Context(),
		`INSERT INTO roles (server_id, name, position, permissions, is_default)
		 VALUES ($1, '@bastion', 0, $2, TRUE)
		 RETURNING id`,
		server.ID, defaultPerms,
	).Scan(&defaultRoleID)
	if err != nil {
		log.Error().Err(err).Msg("failed to create default role")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Assign default role to creator
	_, err = tx.Exec(r.Context(),
		`INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)`,
		server.ID, userID, defaultRoleID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to assign default role")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Create default #general channel
	_, err = tx.Exec(r.Context(),
		`INSERT INTO channels (server_id, name, topic, position) VALUES ($1, 'general', 'General discussion', 0)`,
		server.ID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to create default channel")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		log.Error().Err(err).Msg("failed to commit transaction")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeJSON(w, http.StatusCreated, server)
}

func (h *ServerHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())

	rows, err := h.db.Query(r.Context(),
		`SELECT s.id, s.name, s.icon_url, s.description, s.owner_id, s.created_at,
		        (SELECT COUNT(*) FROM server_members WHERE server_id = s.id) AS member_count
		 FROM servers s
		 INNER JOIN server_members sm ON sm.server_id = s.id
		 WHERE sm.user_id = $1
		 ORDER BY s.created_at DESC`, userID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to list servers")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer rows.Close()

	servers := make([]models.Server, 0)
	for rows.Next() {
		var s models.Server
		if err := rows.Scan(&s.ID, &s.Name, &s.IconURL, &s.Description, &s.OwnerID, &s.CreatedAt, &s.MemberCount); err != nil {
			log.Error().Err(err).Msg("failed to scan server")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		servers = append(servers, s)
	}

	if err := rows.Err(); err != nil {
		log.Error().Err(err).Msg("rows iteration error")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeJSON(w, http.StatusOK, servers)
}

func (h *ServerHandler) Get(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "id"))
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

	var s models.Server
	err = h.db.QueryRow(r.Context(),
		`SELECT id, name, icon_url, description, owner_id, created_at,
		        (SELECT COUNT(*) FROM server_members WHERE server_id = $1) AS member_count
		 FROM servers WHERE id = $1`,
		serverID,
	).Scan(&s.ID, &s.Name, &s.IconURL, &s.Description, &s.OwnerID, &s.CreatedAt, &s.MemberCount)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "server not found"))
		return
	}

	writeJSON(w, http.StatusOK, s)
}

func (h *ServerHandler) Join(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "id"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}

	// Check server exists
	var exists bool
	err = h.db.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM servers WHERE id = $1)`, serverID,
	).Scan(&exists)
	if err != nil || !exists {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "server not found"))
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
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	if isMember {
		writeJSON(w, http.StatusConflict, errorResponse("CONFLICT", "already a member of this server"))
		return
	}

	// Check if banned
	var isBanned bool
	err = h.db.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM server_bans WHERE server_id = $1 AND user_id = $2)`,
		serverID, userID,
	).Scan(&isBanned)
	if err == nil && isBanned {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you are banned from this server"))
		return
	}

	tx, err := h.db.Begin(r.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to begin transaction")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer tx.Rollback(r.Context())

	// Add as member
	var member models.ServerMember
	err = tx.QueryRow(r.Context(),
		`INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)
		 RETURNING server_id, user_id, nickname, role, timed_out_until, joined_at`,
		serverID, userID,
	).Scan(&member.ServerID, &member.UserID, &member.Nickname, &member.Role, &member.TimedOutUntil, &member.JoinedAt)
	if err != nil {
		log.Error().Err(err).Msg("failed to join server")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Assign default @bastion role
	tx.Exec(r.Context(),
		`INSERT INTO member_roles (server_id, user_id, role_id)
		 SELECT $1, $2, id FROM roles WHERE server_id = $1 AND is_default = TRUE`,
		serverID, userID,
	)

	if err := tx.Commit(r.Context()); err != nil {
		log.Error().Err(err).Msg("failed to commit join")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Subscribe new member's WS clients to all server channels
	channelIDs, _ := getServerChannelIDs(r.Context(), h.db, serverID)
	for _, chID := range channelIDs {
		h.hub.SubscribeUser(userID, chID)
	}

	// Broadcast to all server channels so existing members see the new member
	for _, chID := range channelIDs {
		h.hub.BroadcastToChannel(chID, realtime.Event{
			Type: realtime.EventServerMemberJoin,
			Data: map[string]string{
				"serverId": serverID.String(),
				"userId":   userID.String(),
			},
		})
	}

	writeJSON(w, http.StatusCreated, member)
}

type updateServerRequest struct {
	Name        *string `json:"name,omitempty"`
	Description *string `json:"description,omitempty"`
}

func (h *ServerHandler) Update(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "id"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageServer); !ok {
		return
	}

	var req updateServerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	sets := []string{}
	args := []any{}
	argIdx := 1

	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" || len(name) > 100 {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "server name must be 1-100 characters"))
			return
		}
		sets = append(sets, "name = $"+itoa(argIdx))
		args = append(args, name)
		argIdx++
	}

	if req.Description != nil {
		desc := strings.TrimSpace(*req.Description)
		if len(desc) > 1000 {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "description too long (max 1000 chars)"))
			return
		}
		sets = append(sets, "description = $"+itoa(argIdx))
		args = append(args, desc)
		argIdx++
	}

	if len(sets) == 0 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "no fields to update"))
		return
	}

	args = append(args, serverID)
	query := "UPDATE servers SET " + strings.Join(sets, ", ") +
		" WHERE id = $" + itoa(argIdx) +
		" RETURNING id, name, icon_url, description, owner_id, created_at"

	var s models.Server
	err = h.db.QueryRow(r.Context(), query, args...).Scan(
		&s.ID, &s.Name, &s.IconURL, &s.Description, &s.OwnerID, &s.CreatedAt)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "server not found"))
		return
	}

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditServerUpdate, "server", serverID, nil, nil)

	// Broadcast server update to all server channels
	channelIDs, _ := getServerChannelIDs(r.Context(), h.db, serverID)
	for _, chID := range channelIDs {
		h.hub.BroadcastToChannel(chID, realtime.Event{
			Type: realtime.EventServerUpdate,
			Data: s,
		})
	}

	writeJSON(w, http.StatusOK, s)
}

func (h *ServerHandler) UploadIcon(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "id"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageServer); !ok {
		return
	}

	// Limit to 2MB for icons
	r.Body = http.MaxBytesReader(w, r.Body, 2*1024*1024)
	if err := r.ParseMultipartForm(2 * 1024 * 1024); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "file too large (max 2MB)"))
		return
	}

	file, header, err := r.FormFile("icon")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "missing icon file"))
		return
	}
	defer file.Close()

	// Validate content type
	contentType := header.Header.Get("Content-Type")
	if !strings.HasPrefix(contentType, "image/") {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "file must be an image"))
		return
	}

	ext := filepath.Ext(header.Filename)
	if ext == "" {
		ext = ".png"
	}

	_, url, err := h.storage.Save(file, ext)
	if err != nil {
		log.Error().Err(err).Msg("failed to save server icon")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	var s models.Server
	err = h.db.QueryRow(r.Context(),
		`UPDATE servers SET icon_url = $1 WHERE id = $2
		 RETURNING id, name, icon_url, description, owner_id, created_at`,
		url, serverID,
	).Scan(&s.ID, &s.Name, &s.IconURL, &s.Description, &s.OwnerID, &s.CreatedAt)
	if err != nil {
		log.Error().Err(err).Msg("failed to update server icon")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditServerUpdate, "server", serverID, nil, nil)

	// Broadcast server update to all server channels
	channelIDs, _ := getServerChannelIDs(r.Context(), h.db, serverID)
	for _, chID := range channelIDs {
		h.hub.BroadcastToChannel(chID, realtime.Event{
			Type: realtime.EventServerUpdate,
			Data: s,
		})
	}

	writeJSON(w, http.StatusOK, s)
}

func (h *ServerHandler) Leave(w http.ResponseWriter, r *http.Request) {
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
	if err != nil || !isMember {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you are not a member of this server"))
		return
	}

	// Prevent owner from leaving
	var ownerID uuid.UUID
	_ = h.db.QueryRow(r.Context(), `SELECT owner_id FROM servers WHERE id = $1`, serverID).Scan(&ownerID)
	if userID == ownerID {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "server owner cannot leave — delete the server or transfer ownership first"))
		return
	}

	// Remove member and roles
	h.db.Exec(r.Context(),
		`DELETE FROM member_roles WHERE server_id = $1 AND user_id = $2`, serverID, userID)
	_, err = h.db.Exec(r.Context(),
		`DELETE FROM server_members WHERE server_id = $1 AND user_id = $2`, serverID, userID)
	if err != nil {
		log.Error().Err(err).Msg("failed to leave server")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Unsubscribe from all server channels
	channelIDs, _ := getServerChannelIDs(r.Context(), h.db, serverID)
	for _, chID := range channelIDs {
		h.hub.UnsubscribeUser(userID, chID)
	}

	// Broadcast to remaining members
	for _, chID := range channelIDs {
		h.hub.BroadcastToChannel(chID, realtime.Event{
			Type: realtime.EventServerMemberLeave,
			Data: map[string]string{
				"serverId": serverID.String(),
				"userId":   userID.String(),
			},
		})
	}

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditMemberLeave, "member", userID, nil, nil)

	writeJSON(w, http.StatusOK, map[string]string{"status": "left"})
}

func (h *ServerHandler) Delete(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}

	// Owner-only check
	var ownerID uuid.UUID
	err = h.db.QueryRow(r.Context(), `SELECT owner_id FROM servers WHERE id = $1`, serverID).Scan(&ownerID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "server not found"))
		return
	}
	if userID != ownerID {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "only the server owner can delete the server"))
		return
	}

	// Broadcast SERVER_DELETE to all server channels before deletion
	channelIDs, _ := getServerChannelIDs(r.Context(), h.db, serverID)
	for _, chID := range channelIDs {
		h.hub.BroadcastToChannel(chID, realtime.Event{
			Type: realtime.EventServerDelete,
			Data: map[string]string{
				"serverId": serverID.String(),
			},
		})
	}

	// Delete server — cascade deletes handle channels, messages, members, roles, bans, invites, categories, audit log
	_, err = h.db.Exec(r.Context(), `DELETE FROM servers WHERE id = $1`, serverID)
	if err != nil {
		log.Error().Err(err).Msg("failed to delete server")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (h *ServerHandler) UpdateNickname(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}
	targetID, err := parseUUID(chi.URLParam(r, "userID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid user ID"))
		return
	}

	// Permission check: user can change own nickname always (if member),
	// changing others needs ManageNicknames permission
	if userID != targetID {
		if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageNicknames); !ok {
			return
		}
	} else {
		// Verify membership
		if !requireMembership(h.db, w, r, serverID, userID) {
			return
		}
	}

	var req struct {
		Nickname string `json:"nickname"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	nickname := strings.TrimSpace(req.Nickname)
	if len(nickname) > 64 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "nickname too long (max 64 characters)"))
		return
	}

	var nicknamePtr *string
	if nickname != "" {
		nicknamePtr = &nickname
	}

	_, err = h.db.Exec(r.Context(),
		`UPDATE server_members SET nickname = $1 WHERE server_id = $2 AND user_id = $3`,
		nicknamePtr, serverID, targetID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to update nickname")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Broadcast member update so member list refreshes
	channelIDs, _ := getServerChannelIDs(r.Context(), h.db, serverID)
	for _, chID := range channelIDs {
		h.hub.BroadcastToChannel(chID, realtime.Event{
			Type: realtime.EventMemberNicknameUpdate,
			Data: map[string]string{
				"serverId": serverID.String(),
				"userId":   targetID.String(),
				"nickname": nickname,
			},
		})
	}

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditNicknameUpdate, "member", targetID,
		map[string]any{"nickname": nickname}, nil)

	writeJSON(w, http.StatusOK, map[string]string{"status": "updated", "nickname": nickname})
}
