package api

import (
	"encoding/json"
	"net/http"
	"os"
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
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	// Build dynamic update
	sets := []string{}
	args := []any{}
	argIdx := 1

	if req.DisplayName != nil {
		name := strings.TrimSpace(*req.DisplayName)
		if len(name) > 64 {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "display name too long"))
			return
		}
		sets = append(sets, "display_name = $"+itoa(argIdx))
		args = append(args, name)
		argIdx++
	}

	if req.AboutMe != nil {
		aboutMe := strings.TrimSpace(*req.AboutMe)
		if len(aboutMe) > 2000 {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "about me too long"))
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
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid status"))
			return
		}
		sets = append(sets, "status = $"+itoa(argIdx))
		args = append(args, status)
		argIdx++
	}

	if len(sets) == 0 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "no fields to update"))
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
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeJSON(w, http.StatusOK, user)
}

func (h *UserHandler) UploadAvatar(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())

	// Limit to 2MB for avatars
	r.Body = http.MaxBytesReader(w, r.Body, 2*1024*1024)
	if err := r.ParseMultipartForm(2 * 1024 * 1024); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "file too large (max 2MB)"))
		return
	}

	file, _, err := r.FormFile("avatar")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "missing avatar file"))
		return
	}
	defer file.Close()

	// Validate that the file really is an image by inspecting its bytes, not the
	// client-supplied Content-Type header (which is trivially spoofable), and
	// store it under a canonical extension derived from the detected type.
	ct, err := sniffContentType(file)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	if !isInlineRenderable(ct) {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "file must be a PNG, JPEG, GIF, WebP, or BMP image"))
		return
	}
	ext := safeExtensionForType(ct)

	storedName, url, err := h.storage.Save(file, ext)
	if err != nil {
		log.Error().Err(err).Msg("failed to save avatar")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
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
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeJSON(w, http.StatusOK, user)
}

func (h *UserHandler) GetUser(w http.ResponseWriter, r *http.Request) {
	targetID, err := parseUUID(chi.URLParam(r, "userID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid user ID"))
		return
	}

	var user models.User
	err = h.db.QueryRow(r.Context(),
		`SELECT id, username, email, password_hash, display_name, avatar_url, status, about_me, created_at, updated_at
		 FROM users WHERE id = $1`, targetID,
	).Scan(&user.ID, &user.Username, &user.Email, &user.PasswordHash,
		&user.DisplayName, &user.AvatarURL, &user.Status, &user.AboutMe, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "user not found"))
		return
	}

	writeJSON(w, http.StatusOK, user)
}

func (h *UserHandler) GetMembers(w http.ResponseWriter, r *http.Request) {
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

	rows, err := h.db.Query(r.Context(),
		`SELECT sm.server_id, sm.user_id, u.username, u.display_name, u.avatar_url,
		        sm.nickname, sm.role, u.status, u.is_bot, sm.timed_out_until, sm.joined_at
		 FROM server_members sm
		 INNER JOIN users u ON u.id = sm.user_id
		 WHERE sm.server_id = $1
		 ORDER BY sm.role ASC, u.username ASC`, serverID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to list members")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer rows.Close()

	members := make([]models.MemberWithUser, 0)
	for rows.Next() {
		var m models.MemberWithUser
		if err := rows.Scan(&m.ServerID, &m.UserID, &m.Username, &m.DisplayName,
			&m.AvatarURL, &m.Nickname, &m.Role, &m.Status, &m.IsBot, &m.TimedOutUntil, &m.JoinedAt); err != nil {
			log.Error().Err(err).Msg("failed to scan member")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}

		// Presence from Redis: key exists = online/status, key missing = offline
		if h.rdb != nil {
			presenceStatus, err := h.rdb.Get(r.Context(), "presence:"+m.UserID.String()).Result()
			if err == nil && presenceStatus != "" {
				m.Status = presenceStatus
			} else {
				m.Status = "offline"
			}
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
	// Path is everything after /api/uploads/. http.ServeContent (like ServeFile)
	// rejects any "..", so path traversal is not possible here.
	filePath := chi.URLParam(r, "*")
	if filePath == "" {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "file not found"))
		return
	}

	f, err := os.Open(h.storage.FullPath(filePath))
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "file not found"))
		return
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "file not found"))
		return
	}

	// Determine the content type from the file's own bytes — never a stored or
	// client-supplied value — and forbid content-type sniffing. Only a small
	// allowlist of image types is served inline; everything else is forced to
	// download, so an uploaded HTML/SVG/script cannot execute on this origin.
	ct, err := sniffContentType(f)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if isInlineRenderable(ct) {
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Content-Disposition", "inline")
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", "attachment")
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}

// itoa converts int to string without importing strconv
func itoa(i int) string {
	if i < 10 {
		return string(rune('0' + i))
	}
	return itoa(i/10) + string(rune('0'+i%10))
}

func (h *UserHandler) SearchUsers(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())

	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" || len(q) > 100 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "query parameter 'q' is required (max 100 chars)"))
		return
	}

	// Search users who share at least one server with the requester
	rows, err := h.db.Query(r.Context(),
		`SELECT DISTINCT u.id, u.username, u.display_name, u.avatar_url
		 FROM users u
		 INNER JOIN server_members sm1 ON sm1.user_id = u.id
		 INNER JOIN server_members sm2 ON sm2.server_id = sm1.server_id AND sm2.user_id = $1
		 WHERE u.id != $1 AND (u.username ILIKE $2 OR u.display_name ILIKE $2)
		 ORDER BY u.username ASC
		 LIMIT 20`,
		userID, q+"%",
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to search users")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer rows.Close()

	users := make([]models.Author, 0)
	for rows.Next() {
		var u models.Author
		if err := rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.AvatarURL); err != nil {
			log.Error().Err(err).Msg("failed to scan user")
			continue
		}
		users = append(users, u)
	}

	writeJSON(w, http.StatusOK, users)
}

func (h *UserHandler) ChangePassword(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())

	var req struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	if len(req.NewPassword) < 8 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "new password must be at least 8 characters"))
		return
	}

	// Fetch current hash
	var hash string
	err := h.db.QueryRow(r.Context(),
		`SELECT password_hash FROM users WHERE id = $1`, userID,
	).Scan(&hash)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Verify current password
	match, err := auth.VerifyPassword(hash, req.CurrentPassword)
	if err != nil || !match {
		writeJSON(w, http.StatusUnauthorized, errorResponse("AUTH_REQUIRED", "current password is incorrect"))
		return
	}

	// Hash new password
	newHash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		log.Error().Err(err).Msg("failed to hash password")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	_, err = h.db.Exec(r.Context(),
		`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
		newHash, userID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to update password")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *UserHandler) ChangeEmail(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())

	var req struct {
		NewEmail string `json:"newEmail"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	req.NewEmail = strings.TrimSpace(strings.ToLower(req.NewEmail))
	if req.NewEmail == "" || !strings.Contains(req.NewEmail, "@") {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid email address"))
		return
	}

	// Verify password
	var hash string
	err := h.db.QueryRow(r.Context(),
		`SELECT password_hash FROM users WHERE id = $1`, userID,
	).Scan(&hash)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	match, err := auth.VerifyPassword(hash, req.Password)
	if err != nil || !match {
		writeJSON(w, http.StatusUnauthorized, errorResponse("AUTH_REQUIRED", "password is incorrect"))
		return
	}

	// Check email not taken
	var exists bool
	h.db.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM users WHERE email = $1 AND id != $2)`,
		req.NewEmail, userID,
	).Scan(&exists)
	if exists {
		writeJSON(w, http.StatusConflict, errorResponse("CONFLICT", "email is already in use"))
		return
	}

	var user models.User
	err = h.db.QueryRow(r.Context(),
		`UPDATE users SET email = $1, updated_at = NOW() WHERE id = $2
		 RETURNING id, username, email, password_hash, display_name, avatar_url, status, about_me, created_at, updated_at`,
		req.NewEmail, userID,
	).Scan(&user.ID, &user.Username, &user.Email, &user.PasswordHash,
		&user.DisplayName, &user.AvatarURL, &user.Status, &user.AboutMe, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		log.Error().Err(err).Msg("failed to update email")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeJSON(w, http.StatusOK, user)
}

func (h *UserHandler) DeleteAccount(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())

	var req struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	// Verify password
	var hash string
	err := h.db.QueryRow(r.Context(),
		`SELECT password_hash FROM users WHERE id = $1`, userID,
	).Scan(&hash)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	match, err := auth.VerifyPassword(hash, req.Password)
	if err != nil || !match {
		writeJSON(w, http.StatusUnauthorized, errorResponse("AUTH_REQUIRED", "password is incorrect"))
		return
	}

	// Check if user owns any servers — must transfer or delete them first
	var ownsServers bool
	h.db.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM servers WHERE owner_id = $1)`, userID,
	).Scan(&ownsServers)
	if ownsServers {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "you must delete or transfer all servers you own before deleting your account"))
		return
	}

	// Delete user — cascade handles server_members, dm_members, etc.
	// Messages with dangling author_id will show "[Deleted User]"
	_, err = h.db.Exec(r.Context(), `DELETE FROM users WHERE id = $1`, userID)
	if err != nil {
		log.Error().Err(err).Msg("failed to delete account")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Clear presence from Redis
	if h.rdb != nil {
		h.rdb.Del(r.Context(), "presence:"+userID.String())
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
