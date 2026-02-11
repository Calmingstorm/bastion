package api

import (
	"encoding/json"
	"net/http"
	"time"

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

type ModerationHandler struct {
	db  *pgxpool.Pool
	rdb *redis.Client
	hub *realtime.Hub
}

func NewModerationHandler(db *pgxpool.Pool, rdb *redis.Client, hub *realtime.Hub) *ModerationHandler {
	return &ModerationHandler{db: db, rdb: rdb, hub: hub}
}

type kickRequest struct {
	Reason *string `json:"reason,omitempty"`
}

func (h *ModerationHandler) Kick(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}
	targetID, err := parseUUID(chi.URLParam(r, "targetID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid target user ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.KickMembers); !ok {
		return
	}

	// Cannot kick yourself
	if userID == targetID {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "you cannot kick yourself"))
		return
	}

	// Cannot kick the server owner
	var ownerID uuid.UUID
	_ = h.db.QueryRow(r.Context(), `SELECT owner_id FROM servers WHERE id = $1`, serverID).Scan(&ownerID)
	if targetID == ownerID {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "cannot kick the server owner"))
		return
	}

	var req kickRequest
	json.NewDecoder(r.Body).Decode(&req) // optional body

	// Remove member
	_, err = h.db.Exec(r.Context(),
		`DELETE FROM server_members WHERE server_id = $1 AND user_id = $2`,
		serverID, targetID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to kick member")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Also remove their roles
	h.db.Exec(r.Context(),
		`DELETE FROM member_roles WHERE server_id = $1 AND user_id = $2`,
		serverID, targetID,
	)

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditMemberKick, "member", targetID, nil, req.Reason)

	// Notify kicked user directly
	h.hub.BroadcastToUser(targetID, realtime.Event{
		Type: realtime.EventMemberKick,
		Data: map[string]string{"serverId": serverID.String(), "userId": targetID.String()},
	})

	// Broadcast to server channels so remaining members update their member lists
	chIDs, _ := getServerChannelIDs(r.Context(), h.db, serverID)
	for _, chID := range chIDs {
		h.hub.BroadcastToChannel(chID, realtime.Event{
			Type: realtime.EventMemberKick,
			Data: map[string]string{"serverId": serverID.String(), "userId": targetID.String()},
		})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "kicked"})
}

type banRequest struct {
	Reason *string `json:"reason,omitempty"`
}

func (h *ModerationHandler) Ban(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}
	targetID, err := parseUUID(chi.URLParam(r, "targetID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid target user ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.BanMembers); !ok {
		return
	}

	if userID == targetID {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "you cannot ban yourself"))
		return
	}

	var ownerID uuid.UUID
	_ = h.db.QueryRow(r.Context(), `SELECT owner_id FROM servers WHERE id = $1`, serverID).Scan(&ownerID)
	if targetID == ownerID {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "cannot ban the server owner"))
		return
	}

	var req banRequest
	json.NewDecoder(r.Body).Decode(&req)

	tx, err := h.db.Begin(r.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to begin transaction")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer tx.Rollback(r.Context())

	// Create ban record
	_, err = tx.Exec(r.Context(),
		`INSERT INTO server_bans (server_id, user_id, reason, banned_by)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (server_id, user_id) DO UPDATE SET reason = $3, banned_by = $4, created_at = NOW()`,
		serverID, targetID, req.Reason, userID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to create ban")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Remove member + roles
	tx.Exec(r.Context(),
		`DELETE FROM member_roles WHERE server_id = $1 AND user_id = $2`, serverID, targetID)
	tx.Exec(r.Context(),
		`DELETE FROM server_members WHERE server_id = $1 AND user_id = $2`, serverID, targetID)

	if err := tx.Commit(r.Context()); err != nil {
		log.Error().Err(err).Msg("failed to commit ban")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditMemberBan, "member", targetID, nil, req.Reason)

	// Notify banned user directly
	h.hub.BroadcastToUser(targetID, realtime.Event{
		Type: realtime.EventMemberBan,
		Data: map[string]string{"serverId": serverID.String(), "userId": targetID.String()},
	})

	// Broadcast to server channels so remaining members update their member lists
	chIDs, _ := getServerChannelIDs(r.Context(), h.db, serverID)
	for _, chID := range chIDs {
		h.hub.BroadcastToChannel(chID, realtime.Event{
			Type: realtime.EventMemberBan,
			Data: map[string]string{"serverId": serverID.String(), "userId": targetID.String()},
		})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "banned"})
}

func (h *ModerationHandler) Unban(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}
	targetID, err := parseUUID(chi.URLParam(r, "targetID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid target user ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.BanMembers); !ok {
		return
	}

	_, err = h.db.Exec(r.Context(),
		`DELETE FROM server_bans WHERE server_id = $1 AND user_id = $2`,
		serverID, targetID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to unban member")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditMemberUnban, "member", targetID, nil, nil)

	writeJSON(w, http.StatusOK, map[string]string{"status": "unbanned"})
}

func (h *ModerationHandler) ListBans(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.BanMembers); !ok {
		return
	}

	rows, err := h.db.Query(r.Context(),
		`SELECT sb.server_id, sb.user_id, u.username, sb.reason, sb.banned_by, sb.created_at
		 FROM server_bans sb
		 INNER JOIN users u ON u.id = sb.user_id
		 WHERE sb.server_id = $1
		 ORDER BY sb.created_at DESC`, serverID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to list bans")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer rows.Close()

	bans := make([]models.ServerBan, 0)
	for rows.Next() {
		var ban models.ServerBan
		if err := rows.Scan(&ban.ServerID, &ban.UserID, &ban.Username, &ban.Reason,
			&ban.BannedBy, &ban.CreatedAt); err != nil {
			log.Error().Err(err).Msg("failed to scan ban")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		bans = append(bans, ban)
	}

	writeJSON(w, http.StatusOK, bans)
}

type timeoutRequest struct {
	Duration int     `json:"duration"` // seconds
	Reason   *string `json:"reason,omitempty"`
}

func (h *ModerationHandler) Timeout(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}
	targetID, err := parseUUID(chi.URLParam(r, "targetID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid target user ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.TimeoutMembers); !ok {
		return
	}

	if userID == targetID {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "you cannot timeout yourself"))
		return
	}

	var ownerID uuid.UUID
	_ = h.db.QueryRow(r.Context(), `SELECT owner_id FROM servers WHERE id = $1`, serverID).Scan(&ownerID)
	if targetID == ownerID {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "cannot timeout the server owner"))
		return
	}

	var req timeoutRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	if req.Duration < 0 || req.Duration > 28*24*3600 { // max 28 days
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "timeout duration must be 0 to 28 days in seconds"))
		return
	}

	var timedOutUntil *time.Time
	if req.Duration > 0 {
		t := time.Now().Add(time.Duration(req.Duration) * time.Second)
		timedOutUntil = &t
	}

	_, err = h.db.Exec(r.Context(),
		`UPDATE server_members SET timed_out_until = $1 WHERE server_id = $2 AND user_id = $3`,
		timedOutUntil, serverID, targetID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to timeout member")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditMemberTimeout, "member", targetID,
		map[string]any{"duration": req.Duration}, req.Reason)

	// Broadcast timeout to server channels so all members see the change
	var timedOutStr string
	if timedOutUntil != nil {
		timedOutStr = timedOutUntil.Format(time.RFC3339)
	}
	chIDs, _ := getServerChannelIDs(r.Context(), h.db, serverID)
	for _, chID := range chIDs {
		h.hub.BroadcastToChannel(chID, realtime.Event{
			Type: realtime.EventMemberTimeout,
			Data: map[string]string{
				"serverId":      serverID.String(),
				"userId":        targetID.String(),
				"timedOutUntil": timedOutStr,
			},
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status":        "timed_out",
		"timedOutUntil": timedOutUntil,
	})
}
