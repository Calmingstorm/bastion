package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/models"
	"github.com/Calmingstorm/bastion/server/internal/permissions"
	"github.com/Calmingstorm/bastion/server/internal/realtime"
)

type ChannelHandler struct {
	db  *pgxpool.Pool
	hub *realtime.Hub
}

// AfterChannelDeleteExecForTest runs between the delete commit and the
// recipient computation (nil in production). Tests use it to mutate
// authorization inside that window and prove the recipient set is evaluated at
// DELIVERY time, not captured earlier -- the interleaving is otherwise only
// reachable with a locked-row race.
var AfterChannelDeleteExecForTest func()

// AfterChannelCreateSubscribeForTest runs between the create's subscription
// loop and its authorization post-check (nil in production). Tests use it to
// revoke access inside that window and prove the post-check unsubscribes a
// member whose revocation raced the create.
var AfterChannelCreateSubscribeForTest func()

func NewChannelHandler(db *pgxpool.Pool, hub *realtime.Hub) *ChannelHandler {
	return &ChannelHandler{db: db, hub: hub}
}

type createChannelRequest struct {
	Name       string  `json:"name"`
	Topic      *string `json:"topic,omitempty"`
	CategoryID *string `json:"categoryId,omitempty"`
}

type updateChannelRequest struct {
	Name       *string `json:"name,omitempty"`
	Topic      *string `json:"topic,omitempty"`
	CategoryID *string `json:"categoryId,omitempty"`
}

// authorizedMemberIDs returns the deduplicated set of members allowed to SEE
// channel events in this server: the owner plus members whose role union
// carries ViewChannel (or Administrator). Raw membership is NOT authorization
// -- a member whose channel access was revoked must receive no channel events,
// and create/update payloads carry channel metadata that would otherwise leak.
func (h *ChannelHandler) authorizedMemberIDs(r *http.Request, serverID uuid.UUID) []uuid.UUID {
	viewBits := permissions.ViewChannel | permissions.Administrator
	rows, err := h.db.Query(r.Context(), `
		SELECT sm.user_id
		FROM server_members sm
		INNER JOIN servers s ON s.id = sm.server_id
		WHERE sm.server_id = $1
		  AND (s.owner_id = sm.user_id
		       OR (COALESCE((
		            SELECT bit_or(r2.permissions)
		            FROM member_roles mr
		            INNER JOIN roles r2 ON r2.id = mr.role_id
		            WHERE mr.server_id = sm.server_id AND mr.user_id = sm.user_id
		          ), 0) & $2) != 0)`, serverID, viewBits)
	if err != nil {
		log.Error().Err(err).Msg("failed to query authorized members for broadcast")
		return nil
	}
	defer rows.Close()
	var ids []uuid.UUID
	for rows.Next() {
		var uid uuid.UUID
		if err := rows.Scan(&uid); err != nil {
			continue
		}
		ids = append(ids, uid)
	}
	return ids
}

// broadcastToServer delivers a channel event exactly once per AUTHORIZED
// member. Per-channel fanout delivered duplicates and, post-commit, missed
// exclusive subscribers of a deleted channel; raw per-member fanout bypassed
// ViewChannel. Recipients are evaluated at DELIVERY time -- callers may pass a
// just-confirmed set to avoid recomputing it.
func (h *ChannelHandler) broadcastToServer(r *http.Request, serverID uuid.UUID, event realtime.Event, recipients ...[]uuid.UUID) {
	var ids []uuid.UUID
	if len(recipients) > 0 {
		ids = recipients[0]
	} else {
		ids = h.authorizedMemberIDs(r, serverID)
	}
	for _, uid := range ids {
		h.hub.BroadcastToUser(uid, event)
	}
}

func (h *ChannelHandler) List(w http.ResponseWriter, r *http.Request) {
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
	if err != nil {
		log.Error().Err(err).Msg("failed to check membership")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	if !isMember {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you are not a member of this server"))
		return
	}

	// Only list channels the member may view, so channel discovery does not leak
	// hidden channels' names, topics, or IDs.
	viewable, err := realtime.ViewableChannelIDs(r.Context(), h.db, userID)
	if err != nil {
		log.Error().Err(err).Msg("failed to resolve viewable channels")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	rows, err := h.db.Query(r.Context(),
		`SELECT id, server_id, name, topic, type, position, category_id, created_at
		 FROM channels
		 WHERE server_id = $1 AND id = ANY($2)
		 ORDER BY position ASC, created_at ASC`, serverID, viewable,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to list channels")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer rows.Close()

	channels := make([]models.Channel, 0)
	for rows.Next() {
		var ch models.Channel
		if err := rows.Scan(&ch.ID, &ch.ServerID, &ch.Name, &ch.Topic, &ch.Type, &ch.Position, &ch.CategoryID, &ch.CreatedAt); err != nil {
			log.Error().Err(err).Msg("failed to scan channel")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		channels = append(channels, ch)
	}

	if err := rows.Err(); err != nil {
		log.Error().Err(err).Msg("rows iteration error")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeJSON(w, http.StatusOK, channels)
}

func (h *ChannelHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}

	// Verify permission to manage channels
	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageChannels); !ok {
		return
	}

	var req createChannelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	req.Name = strings.TrimSpace(strings.ToLower(req.Name))
	req.Name = strings.ReplaceAll(req.Name, " ", "-")

	if req.Name == "" || len(req.Name) > 100 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "channel name must be 1-100 characters"))
		return
	}

	// Validate categoryId if provided
	var categoryID *uuid.UUID
	if req.CategoryID != nil && *req.CategoryID != "" {
		catID, err := uuid.Parse(*req.CategoryID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid category ID"))
			return
		}
		var exists bool
		err = h.db.QueryRow(r.Context(),
			`SELECT EXISTS(SELECT 1 FROM channel_categories WHERE id = $1 AND server_id = $2)`,
			catID, serverID,
		).Scan(&exists)
		if err != nil || !exists {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "category not found in this server"))
			return
		}
		categoryID = &catID
	}

	// Get the next position
	var maxPos int
	err = h.db.QueryRow(r.Context(),
		`SELECT COALESCE(MAX(position), -1) FROM channels WHERE server_id = $1`, serverID,
	).Scan(&maxPos)
	if err != nil {
		log.Error().Err(err).Msg("failed to get max position")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	var ch models.Channel
	err = h.db.QueryRow(r.Context(),
		`INSERT INTO channels (server_id, name, topic, position, category_id)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id, server_id, name, topic, type, position, category_id, created_at`,
		serverID, req.Name, req.Topic, maxPos+1, categoryID,
	).Scan(&ch.ID, &ch.ServerID, &ch.Name, &ch.Topic, &ch.Type, &ch.Position, &ch.CategoryID, &ch.CreatedAt)
	if err != nil {
		log.Error().Err(err).Msg("failed to create channel")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// A new channel must be USABLE by already-connected clients, not just
	// announced: subscribe every authorized member's live sockets first --
	// without the subscription, subsequent messages in this channel would
	// silently never reach them until reconnect. The post-check below re-reads
	// authorization and the broadcast uses that CONFIRMED set.
	recipients := h.authorizedMemberIDs(r, serverID)
	for _, uid := range recipients {
		h.hub.SubscribeUser(uid, ch.ID)
	}
	if AfterChannelCreateSubscribeForTest != nil {
		AfterChannelCreateSubscribeForTest()
	}
	// POST-CHECK: a revocation can land between reading the recipient set and
	// subscribing. Re-read and unsubscribe anyone no longer authorized; whoever
	// runs last (this check or the revocation's own reconcile) leaves the hub
	// consistent with the database.
	still := make(map[uuid.UUID]bool)
	confirmed := h.authorizedMemberIDs(r, serverID)
	for _, uid := range confirmed {
		still[uid] = true
	}
	for _, uid := range recipients {
		if !still[uid] {
			h.hub.UnsubscribeUser(uid, ch.ID)
		}
	}
	h.broadcastToServer(r, serverID, realtime.Event{
		Type: realtime.EventChannelCreate,
		Data: ch,
	}, confirmed)

	writeJSON(w, http.StatusCreated, ch)
}

func (h *ChannelHandler) Update(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}
	channelID, err := parseUUID(chi.URLParam(r, "channelID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid channel ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageChannels); !ok {
		return
	}

	var req updateChannelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	// Normalize name if provided
	if req.Name != nil {
		name := strings.TrimSpace(strings.ToLower(*req.Name))
		name = strings.ReplaceAll(name, " ", "-")
		if name == "" || len(name) > 100 {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "channel name must be 1-100 characters"))
			return
		}
		req.Name = &name
	}

	// Build dynamic update
	sets := []string{}
	args := []any{}
	argIdx := 1

	if req.Name != nil {
		sets = append(sets, fmt.Sprintf("name = $%d", argIdx))
		args = append(args, *req.Name)
		argIdx++
	}
	if req.Topic != nil {
		sets = append(sets, fmt.Sprintf("topic = $%d", argIdx))
		args = append(args, *req.Topic)
		argIdx++
	}
	if req.CategoryID != nil {
		if *req.CategoryID == "" {
			// Empty string = remove from category
			sets = append(sets, fmt.Sprintf("category_id = $%d", argIdx))
			args = append(args, nil)
			argIdx++
		} else {
			catID, err := uuid.Parse(*req.CategoryID)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid category ID"))
				return
			}
			var exists bool
			err = h.db.QueryRow(r.Context(),
				`SELECT EXISTS(SELECT 1 FROM channel_categories WHERE id = $1 AND server_id = $2)`,
				catID, serverID,
			).Scan(&exists)
			if err != nil || !exists {
				writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "category not found in this server"))
				return
			}
			sets = append(sets, fmt.Sprintf("category_id = $%d", argIdx))
			args = append(args, catID)
			argIdx++
		}
	}

	if len(sets) == 0 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "nothing to update"))
		return
	}

	args = append(args, channelID, serverID)
	query := "UPDATE channels SET " + strings.Join(sets, ", ") +
		fmt.Sprintf(" WHERE id = $%d AND server_id = $%d", argIdx, argIdx+1) +
		" RETURNING id, server_id, name, topic, type, position, category_id, created_at"

	var ch models.Channel
	err = h.db.QueryRow(r.Context(), query, args...).Scan(
		&ch.ID, &ch.ServerID, &ch.Name, &ch.Topic, &ch.Type, &ch.Position, &ch.CategoryID, &ch.CreatedAt)
	if err != nil {
		log.Error().Err(err).Msg("failed to update channel")
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "channel not found"))
		return
	}

	// Broadcast to all server channels
	h.broadcastToServer(r, serverID, realtime.Event{
		Type: realtime.EventChannelUpdate,
		Data: ch,
	})

	// Audit log
	writeAuditLog(h.db, r.Context(), serverID, userID, "CHANNEL_UPDATE", "channel", channelID, map[string]any{
		"name":  ch.Name,
		"topic": ch.Topic,
	}, nil)

	writeJSON(w, http.StatusOK, ch)
}

func (h *ChannelHandler) Delete(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}
	channelID, err := parseUUID(chi.URLParam(r, "channelID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid channel ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageChannels); !ok {
		return
	}

	// Prevent deleting the last channel
	var channelCount int
	err = h.db.QueryRow(r.Context(),
		`SELECT COUNT(*) FROM channels WHERE server_id = $1`, serverID,
	).Scan(&channelCount)
	if err != nil {
		log.Error().Err(err).Msg("failed to count channels")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	if channelCount <= 1 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "cannot delete the last channel"))
		return
	}

	// Get channel name for audit log before deleting
	var channelName string
	h.db.QueryRow(r.Context(), `SELECT name FROM channels WHERE id = $1 AND server_id = $2`, channelID, serverID).Scan(&channelName)

	result, err := h.db.Exec(r.Context(),
		`DELETE FROM channels WHERE id = $1 AND server_id = $2`, channelID, serverID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to delete channel")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	if result.RowsAffected() == 0 {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "channel not found"))
		return
	}

	// Broadcast AFTER the delete commits, never before. The event only carries
	// ids, so clients need no live row for "context" -- and broadcasting first
	// had two real failure modes: a fetch racing the window between broadcast
	// and commit could read the channel back into existence, and a delete that
	// FAILED after broadcasting left every connected client having removed a
	// channel that still exists, with no event that would ever correct them.
	// Authorization is evaluated at DELIVERY time: the recipient set is computed
	// here, after the commit, so a member whose access was revoked between the
	// request and the commit receives nothing. (Visibility is server-scoped, so
	// the deleted row's absence changes no one's authorization.) The hub also
	// forgets the channel -- its subscriber set must not outlive the row.
	if AfterChannelDeleteExecForTest != nil {
		AfterChannelDeleteExecForTest()
	}
	h.broadcastToServer(r, serverID, realtime.Event{
		Type: realtime.EventChannelDelete,
		Data: map[string]string{
			"channelId": channelID.String(),
			"serverId":  serverID.String(),
		},
	})
	h.hub.RemoveChannel(channelID)

	// Audit log
	writeAuditLog(h.db, r.Context(), serverID, userID, "CHANNEL_DELETE", "channel", channelID, map[string]any{
		"name": channelName,
	}, nil)

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

type reorderEntry struct {
	ID         string  `json:"id"`
	Position   int     `json:"position"`
	CategoryID *string `json:"categoryId,omitempty"`
}

func (h *ChannelHandler) Reorder(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageChannels); !ok {
		return
	}

	var entries []reorderEntry
	if err := json.NewDecoder(r.Body).Decode(&entries); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	if len(entries) == 0 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "no channels to reorder"))
		return
	}

	tx, err := h.db.Begin(r.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to begin transaction")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer tx.Rollback(r.Context())

	for _, entry := range entries {
		chID, err := uuid.Parse(entry.ID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid channel ID: "+entry.ID))
			return
		}
		if entry.CategoryID != nil {
			var catID *uuid.UUID
			if *entry.CategoryID != "" {
				parsed, err := uuid.Parse(*entry.CategoryID)
				if err != nil {
					writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid category ID"))
					return
				}
				catID = &parsed
			}
			_, err = tx.Exec(r.Context(),
				`UPDATE channels SET position = $1, category_id = $2 WHERE id = $3 AND server_id = $4`,
				entry.Position, catID, chID, serverID,
			)
		} else {
			_, err = tx.Exec(r.Context(),
				`UPDATE channels SET position = $1 WHERE id = $2 AND server_id = $3`,
				entry.Position, chID, serverID,
			)
		}
		if err != nil {
			log.Error().Err(err).Str("channelID", chID.String()).Msg("failed to update channel position")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		log.Error().Err(err).Msg("failed to commit reorder")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Broadcast channel updates to all server channels
	h.broadcastToServer(r, serverID, realtime.Event{
		Type: realtime.EventChannelUpdate,
		Data: map[string]string{
			"serverId": serverID.String(),
			"type":     "reorder",
		},
	})

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
