package api

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"math/big"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/models"
	"github.com/Calmingstorm/bastion/server/internal/realtime"
)

type InviteHandler struct {
	db  *pgxpool.Pool
	hub *realtime.Hub
}

func NewInviteHandler(db *pgxpool.Pool, hub *realtime.Hub) *InviteHandler {
	return &InviteHandler{db: db, hub: hub}
}

type createInviteRequest struct {
	MaxUses   *int   `json:"maxUses,omitempty"`
	ExpiresIn *int64 `json:"expiresIn,omitempty"` // seconds from now
}

const inviteCharset = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"

func generateInviteCode(length int) (string, error) {
	result := make([]byte, length)
	for i := range result {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(inviteCharset))))
		if err != nil {
			return "", err
		}
		result[i] = inviteCharset[n.Int64()]
	}
	return string(result), nil
}

func (h *InviteHandler) Create(w http.ResponseWriter, r *http.Request) {
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

	var req createInviteRequest
	if r.ContentLength > 0 {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
			return
		}
	}

	code, err := generateInviteCode(8)
	if err != nil {
		log.Error().Err(err).Msg("failed to generate invite code")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	var expiresAt *time.Time
	if req.ExpiresIn != nil && *req.ExpiresIn > 0 {
		t := time.Now().Add(time.Duration(*req.ExpiresIn) * time.Second)
		expiresAt = &t
	}

	var invite models.ServerInvite
	err = h.db.QueryRow(r.Context(),
		`INSERT INTO server_invites (server_id, creator_id, code, max_uses, expires_at)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id, server_id, creator_id, code, max_uses, uses, expires_at, created_at`,
		serverID, userID, code, req.MaxUses, expiresAt,
	).Scan(&invite.ID, &invite.ServerID, &invite.CreatorID, &invite.Code,
		&invite.MaxUses, &invite.Uses, &invite.ExpiresAt, &invite.CreatedAt)
	if err != nil {
		log.Error().Err(err).Msg("failed to create invite")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeJSON(w, http.StatusCreated, invite)
}

func (h *InviteHandler) List(w http.ResponseWriter, r *http.Request) {
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
		`SELECT id, server_id, creator_id, code, max_uses, uses, expires_at, created_at
		 FROM server_invites
		 WHERE server_id = $1 AND (expires_at IS NULL OR expires_at > NOW())
		 ORDER BY created_at DESC`, serverID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to list invites")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer rows.Close()

	invites := make([]models.ServerInvite, 0)
	for rows.Next() {
		var inv models.ServerInvite
		if err := rows.Scan(&inv.ID, &inv.ServerID, &inv.CreatorID, &inv.Code,
			&inv.MaxUses, &inv.Uses, &inv.ExpiresAt, &inv.CreatedAt); err != nil {
			log.Error().Err(err).Msg("failed to scan invite")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		invites = append(invites, inv)
	}

	writeJSON(w, http.StatusOK, invites)
}

func (h *InviteHandler) Delete(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	inviteID, err := parseUUID(chi.URLParam(r, "inviteID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid invite ID"))
		return
	}

	// Only the creator or server owner can delete
	var creatorID, serverOwnerID uuid.UUID
	err = h.db.QueryRow(r.Context(),
		`SELECT si.creator_id, s.owner_id
		 FROM server_invites si
		 INNER JOIN servers s ON s.id = si.server_id
		 WHERE si.id = $1`, inviteID,
	).Scan(&creatorID, &serverOwnerID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "invite not found"))
		return
	}

	if userID != creatorID && userID != serverOwnerID {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you cannot delete this invite"))
		return
	}

	_, err = h.db.Exec(r.Context(), `DELETE FROM server_invites WHERE id = $1`, inviteID)
	if err != nil {
		log.Error().Err(err).Msg("failed to delete invite")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (h *InviteHandler) Join(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	code := chi.URLParam(r, "code")

	if code == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invite code is required"))
		return
	}

	// Find the invite
	var invite models.ServerInvite
	err := h.db.QueryRow(r.Context(),
		`SELECT id, server_id, creator_id, code, max_uses, uses, expires_at, created_at
		 FROM server_invites WHERE code = $1`, code,
	).Scan(&invite.ID, &invite.ServerID, &invite.CreatorID, &invite.Code,
		&invite.MaxUses, &invite.Uses, &invite.ExpiresAt, &invite.CreatedAt)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "invalid invite code"))
		return
	}

	// Check expiration
	if invite.ExpiresAt != nil && invite.ExpiresAt.Before(time.Now()) {
		writeJSON(w, http.StatusGone, errorResponse("NOT_FOUND", "this invite has expired"))
		return
	}

	// Check max uses
	if invite.MaxUses != nil && invite.Uses >= *invite.MaxUses {
		writeJSON(w, http.StatusGone, errorResponse("NOT_FOUND", "this invite has reached its maximum uses"))
		return
	}

	// Check if already a member
	var isMember bool
	err = h.db.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2)`,
		invite.ServerID, userID,
	).Scan(&isMember)
	if err != nil {
		log.Error().Err(err).Msg("failed to check membership")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	if isMember {
		// Already a member — just return the server
		var s models.Server
		h.db.QueryRow(r.Context(),
			`SELECT id, name, icon_url, description, owner_id, created_at FROM servers WHERE id = $1`,
			invite.ServerID,
		).Scan(&s.ID, &s.Name, &s.IconURL, &s.Description, &s.OwnerID, &s.CreatedAt)
		writeJSON(w, http.StatusOK, s)
		return
	}

	// Check if banned
	var isBanned bool
	err = h.db.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM server_bans WHERE server_id = $1 AND user_id = $2)`,
		invite.ServerID, userID,
	).Scan(&isBanned)
	if err == nil && isBanned {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you are banned from this server"))
		return
	}

	// Join the server
	tx, err := h.db.Begin(r.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to begin transaction")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer tx.Rollback(r.Context())

	_, err = tx.Exec(r.Context(),
		`INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)`,
		invite.ServerID, userID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to add member")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Assign default @bastion role
	tx.Exec(r.Context(),
		`INSERT INTO member_roles (server_id, user_id, role_id)
		 SELECT $1, $2, id FROM roles WHERE server_id = $1 AND is_default = TRUE`,
		invite.ServerID, userID,
	)

	// Increment uses
	_, err = tx.Exec(r.Context(),
		`UPDATE server_invites SET uses = uses + 1 WHERE id = $1`, invite.ID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to increment invite uses")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		log.Error().Err(err).Msg("failed to commit transaction")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Get the server to return
	var s models.Server
	h.db.QueryRow(r.Context(),
		`SELECT id, name, icon_url, description, owner_id, created_at FROM servers WHERE id = $1`,
		invite.ServerID,
	).Scan(&s.ID, &s.Name, &s.IconURL, &s.Description, &s.OwnerID, &s.CreatedAt)

	// Subscribe new member's WS clients to all server channels
	channelIDs, _ := getServerChannelIDs(r.Context(), h.db, invite.ServerID)
	for _, chID := range channelIDs {
		h.hub.SubscribeUser(userID, chID)
	}

	// Broadcast member join to server channels
	for _, chID := range channelIDs {
		h.hub.BroadcastToChannel(chID, realtime.Event{
			Type: realtime.EventServerMemberJoin,
			Data: map[string]string{
				"serverId": invite.ServerID.String(),
				"userId":   userID.String(),
			},
		})
	}

	writeJSON(w, http.StatusOK, s)
}

func getServerChannelIDs(ctx context.Context, db *pgxpool.Pool, serverID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := db.Query(ctx, `SELECT id FROM channels WHERE server_id = $1`, serverID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
