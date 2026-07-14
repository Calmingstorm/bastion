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

// AfterChannelCreateStableForTest runs after the create's subscription pass has
// stabilized but before CHANNEL_CREATE is delivered (nil in production). Tests
// use it to revoke access in that window and prove BroadcastToChannel still
// excludes the just-unsubscribed member.
var AfterChannelCreateStableForTest func()

// AfterChannelCreateSubscribeForTest runs between the create's subscription
// loop and its authorization post-check (nil in production). Tests use it to
// revoke access inside that window and prove the post-check unsubscribes a
// member whose revocation raced the create.
var AfterChannelCreateSubscribeForTest func()

// AfterBestEffortAuthzReadForTest runs in the non-convergence best-effort path,
// AFTER the authorized set is read but BEFORE it is speculatively subscribed (nil
// in production). Tests use it to revoke a member inside that window and prove the
// generation guard rolls the speculative subscribe back -- a revoked member must
// never be left subscribed by the fallback (the blocker-2 leak, back door).
var AfterBestEffortAuthzReadForTest func()

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
func (h *ChannelHandler) authorizedMemberIDs(r *http.Request, serverID uuid.UUID) ([]uuid.UUID, error) {
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
		return nil, err
	}
	defer rows.Close()
	var ids []uuid.UUID
	for rows.Next() {
		var uid uuid.UUID
		if err := rows.Scan(&uid); err != nil {
			return nil, err
		}
		ids = append(ids, uid)
	}
	return ids, rows.Err()
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
		var err error
		if ids, err = h.authorizedMemberIDs(r, serverID); err != nil {
			log.Error().Err(err).Msg("failed to resolve authorized members for broadcast")
			return
		}
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
	// announced -- without a live subscription, messages in it never reach them
	// until reconnect. But two lifecycle transitions can race the subscribe: a
	// concurrent ViewChannel revocation (must not leave the revoked member
	// subscribed) and a concurrent deletion of THIS channel (must not resurrect
	// its subscriptions or emit a phantom CHANNEL_CREATE). Both bump the hub's
	// reconcile generation, so the subscribe runs inside a stability loop that
	// re-reads authorization + existence and rolls back if the generation moved
	// -- the same primitive the connect path uses. It returns the CONFIRMED,
	// still-authorized recipient set; the broadcast goes only to that set, and
	// only if the channel still exists.
	_, exists, subErr := h.hub.SubscribeAuthorizedStable(ch.ID, func() ([]uuid.UUID, bool, error) {
		var stillExists bool
		if err := h.db.QueryRow(r.Context(),
			`SELECT EXISTS(SELECT 1 FROM channels WHERE id = $1)`, ch.ID).Scan(&stillExists); err != nil {
			return nil, false, err
		}
		if !stillExists {
			return nil, false, nil
		}
		ids, authErr := h.authorizedMemberIDs(r, serverID)
		if authErr != nil {
			return nil, false, authErr
		}
		// Test seam: fires AFTER the authorized set is read but before the loop's
		// generation re-check, so a revocation (or delete) it triggers happens
		// inside the stability window -- the member is included in THIS pass and
		// must be rolled back and excluded on retry.
		if AfterChannelCreateSubscribeForTest != nil {
			AfterChannelCreateSubscribeForTest()
		}
		return ids, true, nil
	})
	if subErr != nil {
		// The stability loop could not converge (N consecutive racing
		// revocations). Failing closed (drop all subscriptions, stay silent)
		// starves connected authorized clients: they get no messages and the
		// unknown-channel refetch never fires (no first message arrives). But
		// blindly re-subscribing the authorized set and broadcasting can leave a
		// member a concurrent revoke already committed subscribed FOREVER -- the
		// blocker-2 leak through the back door, because this path has no
		// generation guard. So apply the SAME discipline as the stability loop one
		// final time: sample the reconcile generation, subscribe the authorized
		// set, and re-check. If nothing raced, broadcast to the channel (full live
		// delivery, provably leak-free). If a revocation DID race, roll the
		// speculative subscriptions back (no leak), bump the generation so any
		// concurrent legitimate join re-reads, and degrade to a one-time per-user
		// CHANNEL_CREATE: members still learn the channel and self-heal live
		// delivery on reconnect, while a member revoked in the last instant gets
		// at most a transient event their CHANNELS_STALE reconciles away -- never a
		// persistent subscription. If the channel was itself deleted amid the
		// churn, clean up and stay silent.
		log.Warn().Err(subErr).Msg("channel create: subscription did not stabilize; best-effort delivery")
		var stillExists bool
		if err := h.db.QueryRow(r.Context(),
			`SELECT EXISTS(SELECT 1 FROM channels WHERE id = $1)`, ch.ID).Scan(&stillExists); err != nil || !stillExists {
			h.hub.RemoveChannel(ch.ID)
			writeJSON(w, http.StatusCreated, ch)
			return
		}
		gen := h.hub.ReconcileGen()
		if ids, authErr := h.authorizedMemberIDs(r, serverID); authErr == nil {
			// Test seam: fires after the authorized set is read but before the
			// speculative subscribe, so a revocation it triggers lands inside the
			// guard window and MUST be rolled back below.
			if AfterBestEffortAuthzReadForTest != nil {
				AfterBestEffortAuthzReadForTest()
			}
			for _, uid := range ids {
				h.hub.SubscribeUser(uid, ch.ID)
			}
			if h.hub.ReconcileGen() == gen {
				// Converged: every subscribed member stayed authorized across the
				// window, so channel delivery cannot leak.
				h.hub.BroadcastToChannel(ch.ID, realtime.Event{
					Type: realtime.EventChannelCreate,
					Data: ch,
				})
				writeJSON(w, http.StatusCreated, ch)
				return
			}
			// The generation also moves on a concurrent GRANT (a harmless bump) --
			// we cannot tell it from a revoke, so we conservatively roll back and
			// degrade in both cases. On a pure grant this only costs the members a
			// live subscription until they reconnect; correctness is preserved.
			// A revocation raced: undo the speculative subscriptions BEFORE any
			// broadcast so a just-revoked member is never left subscribed, then
			// force concurrent joins to re-read.
			for _, uid := range ids {
				h.hub.UnsubscribeUserFromChannel(uid, ch.ID)
			}
			h.hub.BumpReconcileGen()
		} else {
			log.Error().Err(authErr).Msg("channel create best-effort: authorized members read failed; degrading to no-op delivery")
		}
		// The generation also moves when THIS channel is deleted in the guard
		// window (RemoveChannel bumps it). authorizedMemberIDs is server-scoped and
		// would still return members for a now-gone channel, so a naive degraded
		// broadcast would emit a phantom CHANNEL_CREATE for a deleted channel --
		// and it would NOT self-heal (the members kept ViewChannel, so no
		// CHANNELS_STALE fires; only a manual refetch clears it). Re-check
		// existence before the floor and stay silent if the row is gone, mirroring
		// the stable path. (A residual commit->check gap remains, identical to the
		// stable path's inherent one.)
		var floorExists bool
		if err := h.db.QueryRow(r.Context(),
			`SELECT EXISTS(SELECT 1 FROM channels WHERE id = $1)`, ch.ID).Scan(&floorExists); err != nil || !floorExists {
			h.hub.RemoveChannel(ch.ID)
			writeJSON(w, http.StatusCreated, ch)
			return
		}
		// Degraded floor: one-time per-user delivery to the current authorized set
		// (no persistent subscription). Live delivery self-heals on reconnect.
		if ids, authErr := h.authorizedMemberIDs(r, serverID); authErr == nil {
			for _, uid := range ids {
				h.hub.BroadcastToUser(uid, realtime.Event{
					Type: realtime.EventChannelCreate,
					Data: ch,
				})
			}
		} else {
			log.Error().Err(authErr).Msg("channel create best-effort: authorized members read failed for degraded delivery")
		}
		writeJSON(w, http.StatusCreated, ch)
		return
	}
	if exists {
		// Test seam: fires after the stable pass but before delivery, so a
		// revocation here lands in the window BroadcastToChannel must still
		// exclude (the revoke synchronously unsubscribes the member).
		if AfterChannelCreateStableForTest != nil {
			AfterChannelCreateStableForTest()
		}
		// Deliver to the LIVE channel subscription set under the hub lock, NOT a
		// captured recipient list: SubscribeAuthorizedStable subscribed exactly
		// the authorized members, so a revocation landing between the stable
		// pass and this broadcast has ALREADY unsubscribed them (UnsubscribeUser
		// is synchronous under the same lock) and they are excluded here. This is
		// the intersection of authorization and live subscription Odin's review
		// requires -- a stale confirmed slice would leak CHANNEL_CREATE to a
		// just-revoked member.
		h.hub.BroadcastToChannel(ch.ID, realtime.Event{
			Type: realtime.EventChannelCreate,
			Data: ch,
		})
	} else {
		// Deleted mid-create: leave no subscriptions or phantom event behind.
		h.hub.RemoveChannel(ch.ID)
	}

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

	// Deliver to the LIVE channel subscription set (same atomicity as create):
	// the payload carries channel metadata, so a member whose ViewChannel was
	// revoked concurrently -- and thereby synchronously unsubscribed -- must not
	// receive it. BroadcastToChannel intersects with live subscriptions under
	// the hub lock; a captured recipient slice would leak the metadata.
	h.hub.BroadcastToChannel(channelID, realtime.Event{
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
	// Forget the channel in the hub FIRST -- and thereby bump the reconcile
	// generation -- so a concurrent channel-create's stability loop observes the
	// change and cannot confirm a subscription to (or broadcast a phantom
	// CHANNEL_CREATE for) this now-deleted channel. Only then broadcast the
	// delete. (A tiny commit->RemoveChannel gap remains inherent; a create whose
	// entire stable pass falls inside it is bounded by the loop's ret/attempt
	// cap and the row-existence re-read, not eliminated.)
	h.hub.RemoveChannel(channelID)
	if AfterChannelDeleteExecForTest != nil {
		AfterChannelDeleteExecForTest()
	}
	// Authorization is evaluated at DELIVERY time: the recipient set is computed
	// here, after the commit, so a member whose access was revoked between the
	// request and the commit receives nothing.
	h.broadcastToServer(r, serverID, realtime.Event{
		Type: realtime.EventChannelDelete,
		Data: map[string]string{
			"channelId": channelID.String(),
			"serverId":  serverID.String(),
		},
	})

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
