package api

import (
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/config"
	"github.com/Calmingstorm/bastion/server/internal/models"
	"github.com/Calmingstorm/bastion/server/internal/storage"
)

type UserHandler struct {
	db      *pgxpool.Pool
	rdb     *redis.Client
	storage *storage.FileStorage
	cfg     *config.Config
}

func NewUserHandler(db *pgxpool.Pool, rdb *redis.Client, storage *storage.FileStorage, cfg *config.Config) *UserHandler {
	return &UserHandler{db: db, rdb: rdb, storage: storage, cfg: cfg}
}

type updateProfileRequest struct {
	DisplayName *string `json:"displayName,omitempty"`
	AboutMe     *string `json:"aboutMe,omitempty"`
	Status      *string `json:"status,omitempty"`
}

func (h *UserHandler) UpdateProfile(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())

	var req updateProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))
		return
	}

	// Build dynamic update
	sets := []string{}
	args := []any{}
	argIdx := 1

	if req.DisplayName != nil {
		name := strings.TrimSpace(*req.DisplayName)
		if len(name) > 64 {
			writeJSON(w, http.StatusBadRequest, errorBody("display name too long"))
			return
		}
		sets = append(sets, "display_name = $"+itoa(argIdx))
		args = append(args, name)
		argIdx++
	}

	if req.AboutMe != nil {
		aboutMe := strings.TrimSpace(*req.AboutMe)
		if len(aboutMe) > 2000 {
			writeJSON(w, http.StatusBadRequest, errorBody("about me too long"))
			return
		}
		sets = append(sets, "about_me = $"+itoa(argIdx))
		args = append(args, aboutMe)
		argIdx++
	}

	if req.Status != nil {
		status := strings.TrimSpace(*req.Status)
		valid := map[string]bool{"online": true, "idle": true, "dnd": true, "offline": true}
		if !valid[status] {
			writeJSON(w, http.StatusBadRequest, errorBody("invalid status"))
			return
		}
		sets = append(sets, "status = $"+itoa(argIdx))
		args = append(args, status)
		argIdx++
	}

	if len(sets) == 0 {
		writeJSON(w, http.StatusBadRequest, errorBody("no fields to update"))
		return
	}

	sets = append(sets, "updated_at = NOW()")
	args = append(args, userID)

	query := "UPDATE users SET " + strings.Join(sets, ", ") + " WHERE id = $" + itoa(argIdx) +
		" RETURNING id, username, email, password_hash, display_name, avatar_url, status, about_me, created_at, updated_at"

	var user models.User
	err := h.db.QueryRow(r.Context(), query, args...).Scan(
		&user.ID, &user.Username, &user.Email, &user.PasswordHash,
		&user.DisplayName, &user.AvatarURL, &user.Status, &user.AboutMe, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		log.Error().Err(err).Msg("failed to update profile")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	writeJSON(w, http.StatusOK, user)
}

func (h *UserHandler) UploadAvatar(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())

	// Limit to 2MB for avatars
	r.Body = http.MaxBytesReader(w, r.Body, 2*1024*1024)
	if err := r.ParseMultipartForm(2 * 1024 * 1024); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("file too large (max 2MB)"))
		return
	}

	file, header, err := r.FormFile("avatar")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("missing avatar file"))
		return
	}
	defer file.Close()

	// Validate content type
	contentType := header.Header.Get("Content-Type")
	if !strings.HasPrefix(contentType, "image/") {
		writeJSON(w, http.StatusBadRequest, errorBody("file must be an image"))
		return
	}

	ext := filepath.Ext(header.Filename)
	if ext == "" {
		ext = ".png"
	}

	storedName, url, err := h.storage.Save(file, ext)
	if err != nil {
		log.Error().Err(err).Msg("failed to save avatar")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}
	_ = storedName

	var user models.User
	err = h.db.QueryRow(r.Context(),
		`UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2
		 RETURNING id, username, email, password_hash, display_name, avatar_url, status, about_me, created_at, updated_at`,
		url, userID,
	).Scan(&user.ID, &user.Username, &user.Email, &user.PasswordHash,
		&user.DisplayName, &user.AvatarURL, &user.Status, &user.AboutMe, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		log.Error().Err(err).Msg("failed to update avatar")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	writeJSON(w, http.StatusOK, user)
}

func (h *UserHandler) GetUser(w http.ResponseWriter, r *http.Request) {
	targetID, err := parseUUID(chi.URLParam(r, "userID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid user ID"))
		return
	}

	var user models.User
	err = h.db.QueryRow(r.Context(),
		`SELECT id, username, email, password_hash, display_name, avatar_url, status, about_me, created_at, updated_at
		 FROM users WHERE id = $1`, targetID,
	).Scan(&user.ID, &user.Username, &user.Email, &user.PasswordHash,
		&user.DisplayName, &user.AvatarURL, &user.Status, &user.AboutMe, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorBody("user not found"))
		return
	}

	writeJSON(w, http.StatusOK, user)
}

func (h *UserHandler) GetMembers(w http.ResponseWriter, r *http.Request) {
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
	if err != nil || !isMember {
		writeJSON(w, http.StatusForbidden, errorBody("you are not a member of this server"))
		return
	}

	rows, err := h.db.Query(r.Context(),
		`SELECT sm.server_id, sm.user_id, u.username, u.display_name, u.avatar_url,
		        sm.nickname, sm.role, u.status, sm.timed_out_until, sm.joined_at
		 FROM server_members sm
		 INNER JOIN users u ON u.id = sm.user_id
		 WHERE sm.server_id = $1
		 ORDER BY sm.role ASC, u.username ASC`, serverID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to list members")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}
	defer rows.Close()

	members := make([]models.MemberWithUser, 0)
	for rows.Next() {
		var m models.MemberWithUser
		if err := rows.Scan(&m.ServerID, &m.UserID, &m.Username, &m.DisplayName,
			&m.AvatarURL, &m.Nickname, &m.Role, &m.Status, &m.TimedOutUntil, &m.JoinedAt); err != nil {
			log.Error().Err(err).Msg("failed to scan member")
			writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
			return
		}

		// Overlay presence from Redis if available
		presenceStatus, err := h.rdb.Get(r.Context(), "presence:"+m.UserID.String()).Result()
		if err == nil && presenceStatus != "" {
			m.Status = presenceStatus
		}

		members = append(members, m)
	}

	// Fetch roles for all members in bulk
	roleRows, err := h.db.Query(r.Context(),
		`SELECT mr.user_id, r.id, r.name, r.color, r.position
		 FROM member_roles mr
		 INNER JOIN roles r ON r.id = mr.role_id
		 WHERE mr.server_id = $1 AND r.is_default = FALSE
		 ORDER BY r.position DESC`, serverID,
	)
	if err == nil {
		defer roleRows.Close()
		roleMap := make(map[string][]models.RoleInfo)
		for roleRows.Next() {
			var userIDStr string
			var ri models.RoleInfo
			if err := roleRows.Scan(&userIDStr, &ri.ID, &ri.Name, &ri.Color, &ri.Position); err == nil {
				roleMap[userIDStr] = append(roleMap[userIDStr], ri)
			}
		}
		for i := range members {
			if roles, ok := roleMap[members[i].UserID.String()]; ok {
				members[i].Roles = roles
			}
		}
	}

	writeJSON(w, http.StatusOK, members)
}

func (h *UserHandler) ServeUpload(w http.ResponseWriter, r *http.Request) {
	// Serve file from the uploads directory
	// Path is everything after /api/uploads/
	filePath := chi.URLParam(r, "*")
	if filePath == "" {
		writeJSON(w, http.StatusNotFound, errorBody("file not found"))
		return
	}

	fullPath := h.storage.FullPath(filePath)
	http.ServeFile(w, r, fullPath)
}

// itoa converts int to string without importing strconv
func itoa(i int) string {
	if i < 10 {
		return string(rune('0' + i))
	}
	return itoa(i/10) + string(rune('0'+i%10))
}

// Discard the io import if not needed elsewhere
var _ = io.Discard
