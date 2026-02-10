package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/config"
	"github.com/Calmingstorm/bastion/server/internal/email"
	"github.com/Calmingstorm/bastion/server/internal/models"
)

var usernameRegex = regexp.MustCompile(`^[a-zA-Z0-9_]{3,32}$`)

type AuthHandler struct {
	db       *pgxpool.Pool
	cfg      *config.Config
	rdb      *redis.Client
	emailSvc *email.Service
}

func NewAuthHandler(db *pgxpool.Pool, cfg *config.Config, rdb *redis.Client, emailSvc *email.Service) *AuthHandler {
	return &AuthHandler{db: db, cfg: cfg, rdb: rdb, emailSvc: emailSvc}
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
		 RETURNING id, username, email, password_hash, display_name, avatar_url, status, about_me, created_at, updated_at`,
		req.Username, req.Email, hash, req.Username,
	).Scan(&user.ID, &user.Username, &user.Email, &user.PasswordHash,
		&user.DisplayName, &user.AvatarURL, &user.Status, &user.AboutMe, &user.CreatedAt, &user.UpdatedAt)

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
		`SELECT id, username, email, password_hash, display_name, avatar_url, status, about_me, created_at, updated_at
		 FROM users WHERE email = $1`, req.Email,
	).Scan(&user.ID, &user.Username, &user.Email, &user.PasswordHash,
		&user.DisplayName, &user.AvatarURL, &user.Status, &user.AboutMe, &user.CreatedAt, &user.UpdatedAt)

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
		`SELECT id, username, email, password_hash, display_name, avatar_url, status, about_me, created_at, updated_at
		 FROM users WHERE id = $1`, userID,
	).Scan(&user.ID, &user.Username, &user.Email, &user.PasswordHash,
		&user.DisplayName, &user.AvatarURL, &user.Status, &user.AboutMe, &user.CreatedAt, &user.UpdatedAt)

	if err != nil {
		writeJSON(w, http.StatusNotFound, errorBody("user not found"))
		return
	}

	writeJSON(w, http.StatusOK, user)
}

type forgotPasswordRequest struct {
	Email string `json:"email"`
}

type resetPasswordRequest struct {
	Token    string `json:"token"`
	Password string `json:"password"`
}

func (h *AuthHandler) ForgotPassword(w http.ResponseWriter, r *http.Request) {
	log.Debug().Msg("forgot-password handler entered")
	if !h.cfg.SMTP.Enabled() || h.emailSvc == nil {
		log.Debug().Msg("SMTP not enabled, returning 501")
		writeJSON(w, http.StatusNotImplemented, errorBody("password reset not available"))
		return
	}
	log.Debug().Msg("SMTP is enabled, decoding request")

	var req forgotPasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Debug().Err(err).Msg("failed to decode request")
		writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))
		return
	}

	req.Email = strings.TrimSpace(strings.ToLower(req.Email))
	log.Debug().Str("email", req.Email).Msg("looking up user")
	msg := map[string]string{"message": "If that email exists, a reset link has been sent."}

	// Look up user — always return same message to prevent enumeration
	var userID string
	err := h.db.QueryRow(r.Context(),
		`SELECT id FROM users WHERE email = $1`, req.Email,
	).Scan(&userID)
	log.Debug().Err(err).Str("userID", userID).Msg("db query result")
	if err != nil {
		writeJSON(w, http.StatusOK, msg)
		return
	}

	// Generate secure random token
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		log.Error().Err(err).Msg("failed to generate reset token")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}
	token := hex.EncodeToString(tokenBytes)

	// Store in Redis with 1-hour TTL
	ctx := context.Background()
	if err := h.rdb.Set(ctx, "reset:"+token, userID, 1*time.Hour).Err(); err != nil {
		log.Error().Err(err).Msg("failed to store reset token")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	// Send email
	resetLink := fmt.Sprintf("%s/reset-password?token=%s", h.cfg.Domain, token)
	htmlBody := fmt.Sprintf(`<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
<h2 style="color:#e4e6eb">Password Reset</h2>
<p style="color:#9ea3b0">You requested a password reset for your Bastion account. Click the link below to set a new password:</p>
<p><a href="%s" style="display:inline-block;padding:10px 24px;background:#0ea5e9;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">Reset Password</a></p>
<p style="color:#6b7084;font-size:13px">This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>
</div>`, resetLink)

	if err := h.emailSvc.Send(req.Email, "Bastion — Password Reset", htmlBody); err != nil {
		log.Error().Err(err).Str("email", req.Email).Msg("failed to send reset email")
		// Still return success to prevent enumeration
	}

	writeJSON(w, http.StatusOK, msg)
}

func (h *AuthHandler) ResetPassword(w http.ResponseWriter, r *http.Request) {
	var req resetPasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))
		return
	}

	req.Token = strings.TrimSpace(req.Token)
	if req.Token == "" {
		writeJSON(w, http.StatusBadRequest, errorBody("token is required"))
		return
	}

	if len(req.Password) < 8 {
		writeJSON(w, http.StatusBadRequest, errorBody("password must be at least 8 characters"))
		return
	}

	// Look up token in Redis
	ctx := context.Background()
	userID, err := h.rdb.Get(ctx, "reset:"+req.Token).Result()
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid or expired token"))
		return
	}

	// Hash new password
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		log.Error().Err(err).Msg("failed to hash password")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	// Update password in database
	_, err = h.db.Exec(r.Context(),
		`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
		hash, userID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to update password")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	// Delete token (single-use)
	h.rdb.Del(ctx, "reset:"+req.Token)

	writeJSON(w, http.StatusOK, map[string]string{"message": "Password has been reset."})
}
