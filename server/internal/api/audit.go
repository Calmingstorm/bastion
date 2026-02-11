package api

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/models"
	"github.com/Calmingstorm/bastion/server/internal/permissions"
)

// writeAuditLog inserts an audit log entry. Called from other handlers.
func writeAuditLog(db *pgxpool.Pool, ctx context.Context, serverID, actorID uuid.UUID, actionType, targetType string, targetID uuid.UUID, changes any, reason *string) {
	var changesJSON []byte
	if changes != nil {
		var err error
		changesJSON, err = json.Marshal(changes)
		if err != nil {
			log.Error().Err(err).Msg("failed to marshal audit log changes")
			changesJSON = nil
		}
	}

	var tt *string
	if targetType != "" {
		tt = &targetType
	}
	var tid *uuid.UUID
	if targetID != uuid.Nil {
		tid = &targetID
	}

	_, err := db.Exec(ctx,
		`INSERT INTO audit_log (server_id, actor_id, action_type, target_type, target_id, changes, reason)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		serverID, actorID, actionType, tt, tid, changesJSON, reason,
	)
	if err != nil {
		log.Error().Err(err).Str("action", actionType).Msg("failed to write audit log")
	}
}

type AuditLogHandler struct {
	db *pgxpool.Pool
}

func NewAuditLogHandler(db *pgxpool.Pool) *AuditLogHandler {
	return &AuditLogHandler{db: db}
}

func (h *AuditLogHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}

	// Require MANAGE_SERVER or Administrator to view audit log
	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageServer); !ok {
		return
	}

	// Optional filters
	actionType := r.URL.Query().Get("action")
	actorParam := r.URL.Query().Get("actor")
	limit := 50

	baseQuery := `SELECT al.id, al.server_id, al.actor_id, al.action_type, al.target_type,
		al.target_id, al.changes, al.reason, al.created_at,
		u.id, u.username, u.display_name, u.avatar_url
		FROM audit_log al
		INNER JOIN users u ON u.id = al.actor_id
		WHERE al.server_id = $1`
	args := []any{serverID}
	argIdx := 2

	if actionType != "" {
		baseQuery += " AND al.action_type = $" + itoa(argIdx)
		args = append(args, actionType)
		argIdx++
	}

	if actorParam != "" {
		actorID, err := parseUUID(actorParam)
		if err == nil {
			baseQuery += " AND al.actor_id = $" + itoa(argIdx)
			args = append(args, actorID)
			argIdx++
		}
	}

	baseQuery += " ORDER BY al.created_at DESC LIMIT $" + itoa(argIdx)
	args = append(args, limit)

	rows, err := h.db.Query(r.Context(), baseQuery, args...)
	if err != nil {
		log.Error().Err(err).Msg("failed to list audit log")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer rows.Close()

	entries := make([]models.AuditLogEntry, 0)
	for rows.Next() {
		var e models.AuditLogEntry
		var actor models.Author
		if err := rows.Scan(&e.ID, &e.ServerID, &e.ActorID, &e.ActionType,
			&e.TargetType, &e.TargetID, &e.Changes, &e.Reason, &e.CreatedAt,
			&actor.ID, &actor.Username, &actor.DisplayName, &actor.AvatarURL); err != nil {
			log.Error().Err(err).Msg("failed to scan audit log entry")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		e.Actor = &actor
		entries = append(entries, e)
	}

	writeJSON(w, http.StatusOK, entries)
}
