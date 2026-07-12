package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/models"
	"github.com/Calmingstorm/bastion/server/internal/permissions"
	"github.com/Calmingstorm/bastion/server/internal/realtime"
)

type RoleHandler struct {
	db  *pgxpool.Pool
	rdb *redis.Client
	hub *realtime.Hub
}

func NewRoleHandler(db *pgxpool.Pool, rdb *redis.Client, hub *realtime.Hub) *RoleHandler {
	return &RoleHandler{db: db, rdb: rdb, hub: hub}
}

// getMemberPermissions computes a member's server-level permissions.
func getMemberPermissions(db *pgxpool.Pool, r *http.Request, serverID, userID uuid.UUID) (int64, error) {
	// Get server owner
	var ownerID uuid.UUID
	err := db.QueryRow(r.Context(),
		`SELECT owner_id FROM servers WHERE id = $1`, serverID,
	).Scan(&ownerID)
	if err != nil {
		return 0, err
	}

	if ownerID == userID {
		return permissions.AllPermissions, nil
	}

	// Get all roles for this member
	rows, err := db.Query(r.Context(),
		`SELECT r.id, r.server_id, r.name, r.color, r.position, r.permissions, r.is_default
		 FROM roles r
		 INNER JOIN member_roles mr ON mr.role_id = r.id
		 WHERE mr.server_id = $1 AND mr.user_id = $2
		 ORDER BY r.position DESC`, serverID, userID,
	)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	var roles []permissions.Role
	for rows.Next() {
		var pr permissions.Role
		var isDefault bool
		if err := rows.Scan(&pr.ID, &pr.ServerID, &pr.Name, &pr.Color, &pr.Position, &pr.Permissions, &isDefault); err != nil {
			return 0, err
		}
		pr.IsDefault = isDefault
		roles = append(roles, pr)
	}

	return permissions.ComputeBase(ownerID, userID, roles), nil
}

// requirePermission checks that the calling user has the given permission on the server.
// Returns the user's computed permissions and true if ok, or writes an error response and returns false.
func requirePermission(db *pgxpool.Pool, w http.ResponseWriter, r *http.Request, serverID, userID uuid.UUID, perm int64) (int64, bool) {
	perms, err := getMemberPermissions(db, r, serverID, userID)
	if err != nil {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "not a member of this server"))
		return 0, false
	}
	if !permissions.Has(perms, perm) {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you do not have permission to do that"))
		return 0, false
	}
	return perms, true
}

// requireMembership checks the user is a member of the server.
func requireMembership(db *pgxpool.Pool, w http.ResponseWriter, r *http.Request, serverID, userID uuid.UUID) bool {
	var isMember bool
	err := db.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2)`,
		serverID, userID,
	).Scan(&isMember)
	if err != nil || !isMember {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you are not a member of this server"))
		return false
	}
	return true
}

// highestRolePosition returns the highest position among the roles assigned to
// userID on the server. The default @bastion role is position 0, so any member
// is at least 0; -1 means the user holds no roles at all.
func highestRolePosition(ctx context.Context, db *pgxpool.Pool, serverID, userID uuid.UUID) (int, error) {
	var pos *int
	err := db.QueryRow(ctx,
		`SELECT MAX(r.position)
		 FROM roles r
		 INNER JOIN member_roles mr ON mr.role_id = r.id
		 WHERE mr.server_id = $1 AND mr.user_id = $2`,
		serverID, userID,
	).Scan(&pos)
	if err != nil {
		return -1, err
	}
	if pos == nil {
		return -1, nil
	}
	return *pos, nil
}

// getRolePosition returns the position of a single role on a server.
func getRolePosition(ctx context.Context, db *pgxpool.Pool, serverID, roleID uuid.UUID) (int, error) {
	var pos int
	err := db.QueryRow(ctx,
		`SELECT position FROM roles WHERE id = $1 AND server_id = $2`, roleID, serverID,
	).Scan(&pos)
	return pos, err
}

// isPrivileged reports whether a permission set carries Administrator (which
// server owners also resolve to). Privileged actors bypass role-hierarchy and
// permission-subset checks — they already have full control of the server.
func isPrivileged(perms int64) bool {
	return permissions.Has(perms, permissions.Administrator)
}

// enforceRoleHierarchy verifies a non-privileged actor may act on the target
// role, i.e. the target sits strictly below the actor's highest role. It writes
// a 403/500 and returns false on denial. Privileged actors are allowed through.
func enforceRoleHierarchy(ctx context.Context, db *pgxpool.Pool, w http.ResponseWriter, serverID, actorID, targetRoleID uuid.UUID, actorPerms int64) bool {
	if isPrivileged(actorPerms) {
		return true
	}
	targetPos, err := getRolePosition(ctx, db, serverID, targetRoleID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "role not found"))
		return false
	}
	actorTop, err := highestRolePosition(ctx, db, serverID, actorID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return false
	}
	if targetPos >= actorTop {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you cannot manage a role equal to or higher than your highest role"))
		return false
	}
	return true
}

// enforcePermissionSubset verifies a non-privileged actor only grants permission
// bits they themselves hold. Writes a 403 and returns false on denial.
func enforcePermissionSubset(w http.ResponseWriter, granted, actorPerms int64) bool {
	if isPrivileged(actorPerms) {
		return true
	}
	if granted&^actorPerms != 0 {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you cannot grant permissions you do not have"))
		return false
	}
	return true
}

// enforceMemberHierarchy verifies a non-privileged actor may act on the target
// member, i.e. the actor's highest role sits strictly above the target's. Used
// by moderation (kick/ban/timeout). Writes a 403/500 and returns false on denial.
func enforceMemberHierarchy(ctx context.Context, db *pgxpool.Pool, w http.ResponseWriter, serverID, actorID, targetID uuid.UUID, actorPerms int64) bool {
	if isPrivileged(actorPerms) {
		return true
	}
	actorTop, err := highestRolePosition(ctx, db, serverID, actorID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return false
	}
	targetTop, err := highestRolePosition(ctx, db, serverID, targetID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return false
	}
	if targetTop >= actorTop {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you cannot act on a member with an equal or higher role"))
		return false
	}
	return true
}

type createRoleRequest struct {
	Name        string  `json:"name"`
	Color       *string `json:"color,omitempty"`
	Permissions *int64  `json:"permissions,omitempty"`
}

func (h *RoleHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}

	actorPerms, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageRoles)
	if !ok {
		return
	}

	var req createRoleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 100 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "role name must be 1-100 characters"))
		return
	}

	perms := int64(0)
	if req.Permissions != nil {
		perms = *req.Permissions
	}

	// A non-privileged actor may only grant permission bits they hold.
	if !enforcePermissionSubset(w, perms, actorPerms) {
		return
	}

	// Position: a privileged actor (owner / Administrator) creates the role at the
	// top. A delegated ManageRoles holder must instead create it strictly below
	// their own highest role — otherwise they would create a role they could not
	// then assign, edit, or delete — so we shift existing roles up to open a slot.
	var role models.Role
	if isPrivileged(actorPerms) {
		var maxPos int
		if err := h.db.QueryRow(r.Context(),
			`SELECT COALESCE(MAX(position), 0) FROM roles WHERE server_id = $1`, serverID,
		).Scan(&maxPos); err != nil {
			log.Error().Err(err).Msg("failed to get max role position")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		if err := h.db.QueryRow(r.Context(),
			`INSERT INTO roles (server_id, name, color, position, permissions)
			 VALUES ($1, $2, $3, $4, $5)
			 RETURNING id, server_id, name, color, position, permissions, is_default, created_at`,
			serverID, req.Name, req.Color, maxPos+1, perms,
		).Scan(&role.ID, &role.ServerID, &role.Name, &role.Color, &role.Position,
			&role.Permissions, &role.IsDefault, &role.CreatedAt); err != nil {
			log.Error().Err(err).Msg("failed to create role")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
	} else {
		actorTop, err := highestRolePosition(r.Context(), h.db, serverID, userID)
		if err != nil {
			log.Error().Err(err).Msg("failed to resolve actor role position")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		// The default @bastion role sits at position 0 and must stay the lowest.
		// If the actor's highest role is that default role, there is no slot
		// beneath it to create a manageable role — reject rather than reorder it.
		if actorTop <= 0 {
			writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you do not have a role above the default role, so you cannot create new roles"))
			return
		}
		tx, err := h.db.Begin(r.Context())
		if err != nil {
			log.Error().Err(err).Msg("failed to begin transaction")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		defer func() { _ = tx.Rollback(r.Context()) }()
		if _, err := tx.Exec(r.Context(),
			`UPDATE roles SET position = position + 1 WHERE server_id = $1 AND position >= $2`,
			serverID, actorTop,
		); err != nil {
			log.Error().Err(err).Msg("failed to shift role positions")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		if err := tx.QueryRow(r.Context(),
			`INSERT INTO roles (server_id, name, color, position, permissions)
			 VALUES ($1, $2, $3, $4, $5)
			 RETURNING id, server_id, name, color, position, permissions, is_default, created_at`,
			serverID, req.Name, req.Color, actorTop, perms,
		).Scan(&role.ID, &role.ServerID, &role.Name, &role.Color, &role.Position,
			&role.Permissions, &role.IsDefault, &role.CreatedAt); err != nil {
			log.Error().Err(err).Msg("failed to create role")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		if err := tx.Commit(r.Context()); err != nil {
			log.Error().Err(err).Msg("failed to commit role creation")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
	}

	// Audit log
	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditRoleCreate, "role", role.ID, nil, nil)

	// Broadcast to all server channels
	channelIDs, _ := getServerChannelIDs(r.Context(), h.db, serverID)
	for _, chID := range channelIDs {
		h.hub.BroadcastToChannel(chID, realtime.Event{
			Type: realtime.EventRoleCreate,
			Data: role,
		})
	}

	writeJSON(w, http.StatusCreated, role)
}

func (h *RoleHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}

	if !requireMembership(h.db, w, r, serverID, userID) {
		return
	}

	rows, err := h.db.Query(r.Context(),
		`SELECT id, server_id, name, color, position, permissions, is_default, created_at
		 FROM roles WHERE server_id = $1
		 ORDER BY position DESC`, serverID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to list roles")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer rows.Close()

	roles := make([]models.Role, 0)
	for rows.Next() {
		var role models.Role
		if err := rows.Scan(&role.ID, &role.ServerID, &role.Name, &role.Color, &role.Position,
			&role.Permissions, &role.IsDefault, &role.CreatedAt); err != nil {
			log.Error().Err(err).Msg("failed to scan role")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		roles = append(roles, role)
	}

	writeJSON(w, http.StatusOK, roles)
}

type updateRoleRequest struct {
	Name        *string `json:"name,omitempty"`
	Color       *string `json:"color,omitempty"`
	Permissions *int64  `json:"permissions,omitempty"`
}

func (h *RoleHandler) Update(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}
	roleID, err := parseUUID(chi.URLParam(r, "roleID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid role ID"))
		return
	}

	actorPerms, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageRoles)
	if !ok {
		return
	}

	var req updateRoleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	// A non-privileged actor may only edit roles below their highest role, and
	// may only set permission bits they themselves hold (which prevents editing
	// the @bastion default role, or any role, up to Administrator).
	if !enforceRoleHierarchy(r.Context(), h.db, w, serverID, userID, roleID, actorPerms) {
		return
	}
	if req.Permissions != nil && !enforcePermissionSubset(w, *req.Permissions, actorPerms) {
		return
	}

	// Build dynamic update
	sets := []string{}
	args := []any{}
	argIdx := 1

	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" || len(name) > 100 {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "role name must be 1-100 characters"))
			return
		}
		sets = append(sets, "name = $"+itoa(argIdx))
		args = append(args, name)
		argIdx++
	}

	if req.Color != nil {
		sets = append(sets, "color = $"+itoa(argIdx))
		args = append(args, *req.Color)
		argIdx++
	}

	if req.Permissions != nil {
		sets = append(sets, "permissions = $"+itoa(argIdx))
		args = append(args, *req.Permissions)
		argIdx++
	}

	if len(sets) == 0 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "no fields to update"))
		return
	}

	args = append(args, roleID, serverID)
	query := "UPDATE roles SET " + strings.Join(sets, ", ") +
		" WHERE id = $" + itoa(argIdx) + " AND server_id = $" + itoa(argIdx+1) +
		" RETURNING id, server_id, name, color, position, permissions, is_default, created_at"

	var role models.Role
	err = h.db.QueryRow(r.Context(), query, args...).Scan(
		&role.ID, &role.ServerID, &role.Name, &role.Color, &role.Position,
		&role.Permissions, &role.IsDefault, &role.CreatedAt)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "role not found"))
		return
	}

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditRoleUpdate, "role", role.ID, nil, nil)

	// Broadcast to all server channels
	channelIDs, _ := getServerChannelIDs(r.Context(), h.db, serverID)
	for _, chID := range channelIDs {
		h.hub.BroadcastToChannel(chID, realtime.Event{
			Type: realtime.EventRoleUpdate,
			Data: role,
		})
	}

	writeJSON(w, http.StatusOK, role)
}

func (h *RoleHandler) Delete(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}
	roleID, err := parseUUID(chi.URLParam(r, "roleID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid role ID"))
		return
	}

	actorPerms, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageRoles)
	if !ok {
		return
	}

	// Cannot delete the default @bastion role
	var isDefault bool
	err = h.db.QueryRow(r.Context(),
		`SELECT is_default FROM roles WHERE id = $1 AND server_id = $2`, roleID, serverID,
	).Scan(&isDefault)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "role not found"))
		return
	}
	if isDefault {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "cannot delete the default role"))
		return
	}

	// A non-privileged actor may only delete roles below their highest role.
	if !enforceRoleHierarchy(r.Context(), h.db, w, serverID, userID, roleID, actorPerms) {
		return
	}

	_, err = h.db.Exec(r.Context(),
		`DELETE FROM roles WHERE id = $1 AND server_id = $2`, roleID, serverID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to delete role")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditRoleDelete, "role", roleID, nil, nil)

	// Broadcast to all server channels
	channelIDs, _ := getServerChannelIDs(r.Context(), h.db, serverID)
	for _, chID := range channelIDs {
		h.hub.BroadcastToChannel(chID, realtime.Event{
			Type: realtime.EventRoleDelete,
			Data: map[string]string{
				"roleId":   roleID.String(),
				"serverId": serverID.String(),
			},
		})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

type assignRoleRequest struct {
	UserID string `json:"userId"`
}

func (h *RoleHandler) AssignRole(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}
	roleID, err := parseUUID(chi.URLParam(r, "roleID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid role ID"))
		return
	}

	actorPerms, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageRoles)
	if !ok {
		return
	}

	// A non-privileged actor may only assign roles below their highest role,
	// which blocks self-granting an equal or higher (e.g. Administrator) role.
	if !enforceRoleHierarchy(r.Context(), h.db, w, serverID, userID, roleID, actorPerms) {
		return
	}

	var req assignRoleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	targetID, err := parseUUID(req.UserID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid user ID"))
		return
	}

	// Verify target is a member
	if !requireMembership(h.db, w, r, serverID, targetID) {
		return
	}

	_, err = h.db.Exec(r.Context(),
		`INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
		serverID, targetID, roleID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to assign role")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditMemberRoleUpdate, "member", targetID, nil, nil)

	// Broadcast to all server channels
	channelIDs, _ := getServerChannelIDs(r.Context(), h.db, serverID)
	for _, chID := range channelIDs {
		h.hub.BroadcastToChannel(chID, realtime.Event{
			Type: realtime.EventRoleAssigned,
			Data: map[string]string{
				"serverId": serverID.String(),
				"roleId":   roleID.String(),
				"userId":   targetID.String(),
			},
		})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "assigned"})
}

func (h *RoleHandler) RemoveRole(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}
	roleID, err := parseUUID(chi.URLParam(r, "roleID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid role ID"))
		return
	}

	actorPerms, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageRoles)
	if !ok {
		return
	}

	// Cannot remove members from the default role
	var isDefault bool
	err = h.db.QueryRow(r.Context(),
		`SELECT is_default FROM roles WHERE id = $1 AND server_id = $2`, roleID, serverID,
	).Scan(&isDefault)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "role not found"))
		return
	}
	if isDefault {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "cannot remove members from the default role"))
		return
	}

	// A non-privileged actor may only remove roles below their highest role.
	if !enforceRoleHierarchy(r.Context(), h.db, w, serverID, userID, roleID, actorPerms) {
		return
	}

	var req assignRoleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	targetID, err := parseUUID(req.UserID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid user ID"))
		return
	}

	_, err = h.db.Exec(r.Context(),
		`DELETE FROM member_roles WHERE server_id = $1 AND user_id = $2 AND role_id = $3`,
		serverID, targetID, roleID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to remove role")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditMemberRoleUpdate, "member", targetID, nil, nil)

	// Broadcast to all server channels
	channelIDs, _ := getServerChannelIDs(r.Context(), h.db, serverID)
	for _, chID := range channelIDs {
		h.hub.BroadcastToChannel(chID, realtime.Event{
			Type: realtime.EventRoleRemoved,
			Data: map[string]string{
				"serverId": serverID.String(),
				"roleId":   roleID.String(),
				"userId":   targetID.String(),
			},
		})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "removed"})
}

// GetMemberPermissions returns the computed permissions for the current user on a server.
func (h *RoleHandler) GetMemberPermissions(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}

	perms, err := getMemberPermissions(h.db, r, serverID, userID)
	if err != nil {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "not a member of this server"))
		return
	}

	writeJSON(w, http.StatusOK, map[string]int64{"permissions": perms})
}
