package api

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/config"
	"github.com/Calmingstorm/bastion/server/internal/models"
)

var usernameRegex = regexp.MustCompile(`^[a-zA-Z0-9_]{3,32}$`)

type AuthHandler struct {
	db  *pgxpool.Pool
	cfg *config.Config
}

func NewAuthHandler(db *pgxpool.Pool, cfg *config.Config) *AuthHandler {
	return &AuthHandler{db: db, cfg: cfg}
}

type registerRequest struct {
	Username string `json:"username"`
	Email    string `json:"email"`
	Password string `json:"password"`
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type refreshRequest struct {
	RefreshToken string `json:"refreshToken"`
}

type authResponse struct {
	AccessToken  string      `json:"accessToken"`
	RefreshToken string      `json:"refreshToken"`
	User         models.User `json:"user"`
}

type tokenResponse struct {
	AccessToken string `json:"accessToken"`
}

func (h *AuthHandler) Register(w http.ResponseWriter, r *http.Request) {
	var req registerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))
		return
	}

	req.Username = strings.TrimSpace(req.Username)
	req.Email = strings.TrimSpace(strings.ToLower(req.Email))
	req.Password = strings.TrimSpace(req.Password)

	// Validate username
	if !usernameRegex.MatchString(req.Username) {
		writeJSON(w, http.StatusBadRequest, errorBody("username must be 3-32 characters and contain only letters, numbers, and underscores"))
		return
	}

	// Validate email (basic check)
	if !strings.Contains(req.Email, "@") || len(req.Email) < 5 {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid email address"))
		return
	}

	// Validate password
	if len(req.Password) < 8 {
		writeJSON(w, http.StatusBadRequest, errorBody("password must be at least 8 characters"))
		return
	}

	// Hash password
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		log.Error().Err(err).Msg("failed to hash password")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	// Insert user
	var user models.User
	err = h.db.QueryRow(r.Context(),
		`INSERT INTO users (username, email, password_hash, display_name, status)
		 VALUES ($1, $2, $3, $4, 'online')
		 RETURNING id, username, email, password_hash, display_name, avatar_url, status, created_at, updated_at`,
		req.Username, req.Email, hash, req.Username,
	).Scan(&user.ID, &user.Username, &user.Email, &user.PasswordHash,
		&user.DisplayName, &user.AvatarURL, &user.Status, &user.CreatedAt, &user.UpdatedAt)

	if err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, "users_username_key") {
			writeJSON(w, http.StatusConflict, errorBody("username already taken"))
			return
		}
		if strings.Contains(errMsg, "users_email_key") {
			writeJSON(w, http.StatusConflict, errorBody("email already registered"))
			return
		}
		log.Error().Err(err).Msg("failed to insert user")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	// Generate tokens
	accessToken, err := auth.GenerateAccessToken(user.ID, h.cfg.JWT.Secret, h.cfg.JWT.AccessTTL)
	if err != nil {
		log.Error().Err(err).Msg("failed to generate access token")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	refreshToken, err := auth.GenerateRefreshToken(user.ID, h.cfg.JWT.Secret, h.cfg.JWT.RefreshTTL)
	if err != nil {
		log.Error().Err(err).Msg("failed to generate refresh token")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	writeJSON(w, http.StatusCreated, authResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		User:         user,
	})
}

func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))
		return
	}

	req.Email = strings.TrimSpace(strings.ToLower(req.Email))

	// Find user by email
	var user models.User
	err := h.db.QueryRow(r.Context(),
		`SELECT id, username, email, password_hash, display_name, avatar_url, status, created_at, updated_at
		 FROM users WHERE email = $1`, req.Email,
	).Scan(&user.ID, &user.Username, &user.Email, &user.PasswordHash,
		&user.DisplayName, &user.AvatarURL, &user.Status, &user.CreatedAt, &user.UpdatedAt)

	if err != nil {
		writeJSON(w, http.StatusUnauthorized, errorBody("invalid email or password"))
		return
	}

	// Verify password
	match, err := auth.VerifyPassword(user.PasswordHash, req.Password)
	if err != nil || !match {
		writeJSON(w, http.StatusUnauthorized, errorBody("invalid email or password"))
		return
	}

	// Generate tokens
	accessToken, err := auth.GenerateAccessToken(user.ID, h.cfg.JWT.Secret, h.cfg.JWT.AccessTTL)
	if err != nil {
		log.Error().Err(err).Msg("failed to generate access token")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	refreshToken, err := auth.GenerateRefreshToken(user.ID, h.cfg.JWT.Secret, h.cfg.JWT.RefreshTTL)
	if err != nil {
		log.Error().Err(err).Msg("failed to generate refresh token")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	writeJSON(w, http.StatusOK, authResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		User:         user,
	})
}

func (h *AuthHandler) Refresh(w http.ResponseWriter, r *http.Request) {
	var req refreshRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))
		return
	}

	claims, err := auth.ValidateToken(req.RefreshToken, h.cfg.JWT.Secret)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, errorBody("invalid refresh token"))
		return
	}

	if claims.TokenType != "refresh" {
		writeJSON(w, http.StatusUnauthorized, errorBody("invalid token type"))
		return
	}

	userID, err := parseUUID(claims.Subject)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, errorBody("invalid token subject"))
		return
	}

	// Verify user still exists
	var exists bool
	err = h.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)`, userID).Scan(&exists)
	if err != nil || !exists {
		writeJSON(w, http.StatusUnauthorized, errorBody("user not found"))
		return
	}

	accessToken, err := auth.GenerateAccessToken(userID, h.cfg.JWT.Secret, h.cfg.JWT.AccessTTL)
	if err != nil {
		log.Error().Err(err).Msg("failed to generate access token")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	writeJSON(w, http.StatusOK, tokenResponse{AccessToken: accessToken})
}

func (h *AuthHandler) GetMe(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())

	var user models.User
	err := h.db.QueryRow(r.Context(),
		`SELECT id, username, email, password_hash, display_name, avatar_url, status, created_at, updated_at
		 FROM users WHERE id = $1`, userID,
	).Scan(&user.ID, &user.Username, &user.Email, &user.PasswordHash,
		&user.DisplayName, &user.AvatarURL, &user.Status, &user.CreatedAt, &user.UpdatedAt)

	if err != nil {
		writeJSON(w, http.StatusNotFound, errorBody("user not found"))
		return
	}

	writeJSON(w, http.StatusOK, user)
}
