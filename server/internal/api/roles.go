package api

import (
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
		writeJSON(w, http.StatusForbidden, errorBody("not a member of this server"))
		return 0, false
	}
	if !permissions.Has(perms, perm) {
		writeJSON(w, http.StatusForbidden, errorBody("you do not have permission to do that"))
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
		writeJSON(w, http.StatusForbidden, errorBody("you are not a member of this server"))
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
		writeJSON(w, http.StatusBadRequest, errorBody("invalid server ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageRoles); !ok {
		return
	}

	var req createRoleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))
		return
	}

	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 100 {
		writeJSON(w, http.StatusBadRequest, errorBody("role name must be 1-100 characters"))
		return
	}

	// Get next position (above all existing non-default roles)
	var maxPos int
	err = h.db.QueryRow(r.Context(),
		`SELECT COALESCE(MAX(position), 0) FROM roles WHERE server_id = $1`,
		serverID,
	).Scan(&maxPos)
	if err != nil {
		log.Error().Err(err).Msg("failed to get max role position")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	perms := int64(0)
	if req.Permissions != nil {
		perms = *req.Permissions
	}

	var role models.Role
	err = h.db.QueryRow(r.Context(),
		`INSERT INTO roles (server_id, name, color, position, permissions)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id, server_id, name, color, position, permissions, is_default, created_at`,
		serverID, req.Name, req.Color, maxPos+1, perms,
	).Scan(&role.ID, &role.ServerID, &role.Name, &role.Color, &role.Position,
		&role.Permissions, &role.IsDefault, &role.CreatedAt)
	if err != nil {
		log.Error().Err(err).Msg("failed to create role")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	// Audit log
	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditRoleCreate, "role", role.ID, nil, nil)

	writeJSON(w, http.StatusCreated, role)
}

func (h *RoleHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid server ID"))
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
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}
	defer rows.Close()

	roles := make([]models.Role, 0)
	for rows.Next() {
		var role models.Role
		if err := rows.Scan(&role.ID, &role.ServerID, &role.Name, &role.Color, &role.Position,
			&role.Permissions, &role.IsDefault, &role.CreatedAt); err != nil {
			log.Error().Err(err).Msg("failed to scan role")
			writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
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
		writeJSON(w, http.StatusBadRequest, errorBody("invalid server ID"))
		return
	}
	roleID, err := parseUUID(chi.URLParam(r, "roleID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid role ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageRoles); !ok {
		return
	}

	var req updateRoleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))
		return
	}

	// Build dynamic update
	sets := []string{}
	args := []any{}
	argIdx := 1

	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" || len(name) > 100 {
			writeJSON(w, http.StatusBadRequest, errorBody("role name must be 1-100 characters"))
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
		writeJSON(w, http.StatusBadRequest, errorBody("no fields to update"))
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
		writeJSON(w, http.StatusNotFound, errorBody("role not found"))
		return
	}

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditRoleUpdate, "role", role.ID, nil, nil)

	writeJSON(w, http.StatusOK, role)
}

func (h *RoleHandler) Delete(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid server ID"))
		return
	}
	roleID, err := parseUUID(chi.URLParam(r, "roleID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid role ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageRoles); !ok {
		return
	}

	// Cannot delete the default @bastion role
	var isDefault bool
	err = h.db.QueryRow(r.Context(),
		`SELECT is_default FROM roles WHERE id = $1 AND server_id = $2`, roleID, serverID,
	).Scan(&isDefault)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorBody("role not found"))
		return
	}
	if isDefault {
		writeJSON(w, http.StatusBadRequest, errorBody("cannot delete the default role"))
		return
	}

	_, err = h.db.Exec(r.Context(),
		`DELETE FROM roles WHERE id = $1 AND server_id = $2`, roleID, serverID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to delete role")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditRoleDelete, "role", roleID, nil, nil)

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

type assignRoleRequest struct {
	UserID string `json:"userId"`
}

func (h *RoleHandler) AssignRole(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid server ID"))
		return
	}
	roleID, err := parseUUID(chi.URLParam(r, "roleID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid role ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageRoles); !ok {
		return
	}

	var req assignRoleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))
		return
	}

	targetID, err := parseUUID(req.UserID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid user ID"))
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
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditMemberRoleUpdate, "member", targetID, nil, nil)

	writeJSON(w, http.StatusOK, map[string]string{"status": "assigned"})
}

func (h *RoleHandler) RemoveRole(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid server ID"))
		return
	}
	roleID, err := parseUUID(chi.URLParam(r, "roleID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid role ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageRoles); !ok {
		return
	}

	// Cannot remove members from the default role
	var isDefault bool
	err = h.db.QueryRow(r.Context(),
		`SELECT is_default FROM roles WHERE id = $1 AND server_id = $2`, roleID, serverID,
	).Scan(&isDefault)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorBody("role not found"))
		return
	}
	if isDefault {
		writeJSON(w, http.StatusBadRequest, errorBody("cannot remove members from the default role"))
		return
	}

	var req assignRoleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))
		return
	}

	targetID, err := parseUUID(req.UserID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid user ID"))
		return
	}

	_, err = h.db.Exec(r.Context(),
		`DELETE FROM member_roles WHERE server_id = $1 AND user_id = $2 AND role_id = $3`,
		serverID, targetID, roleID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to remove role")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditMemberRoleUpdate, "member", targetID, nil, nil)

	writeJSON(w, http.StatusOK, map[string]string{"status": "removed"})
}

// GetMemberPermissions returns the computed permissions for the current user on a server.
func (h *RoleHandler) GetMemberPermissions(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid server ID"))
		return
	}

	perms, err := getMemberPermissions(h.db, r, serverID, userID)
	if err != nil {
		writeJSON(w, http.StatusForbidden, errorBody("not a member of this server"))
		return
	}

	writeJSON(w, http.StatusOK, map[string]int64{"permissions": perms})
}
