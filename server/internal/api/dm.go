package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/models"
	"github.com/Calmingstorm/bastion/server/internal/realtime"
)

// directDMKey returns the two user IDs in canonical order (lo < hi by the same
// byte comparison PostgreSQL uses for uuid), so a 1:1 DM maps to exactly one key
// regardless of who initiates it.
func directDMKey(a, b uuid.UUID) (lo, hi uuid.UUID) {
	if bytes.Compare(a[:], b[:]) > 0 {
		return b, a
	}
	return a, b
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

type DMHandler struct {
	db  *pgxpool.Pool
	hub *realtime.Hub
}

func NewDMHandler(db *pgxpool.Pool, hub *realtime.Hub) *DMHandler {
	return &DMHandler{db: db, hub: hub}
}

type createDMRequest struct {
	RecipientIDs []string `json:"recipientIds"`
}

func (h *DMHandler) CreateOrGet(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())

	var req createDMRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	if len(req.RecipientIDs) == 0 || len(req.RecipientIDs) > 9 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "1-9 recipients required"))
		return
	}

	// 1:1 DMs are keyed by their canonical member pair and de-duplicated by a
	// unique index, so concurrent creates converge on one channel.
	if len(req.RecipientIDs) == 1 {
		h.createOrGetDirect(w, r, userID, req.RecipientIDs[0])
		return
	}

	// Group DM: always a fresh channel (no direct key).
	tx, err := h.db.Begin(r.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to begin transaction")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer tx.Rollback(r.Context())

	var channelID string
	err = tx.QueryRow(r.Context(),
		`INSERT INTO channels (name, type, dm_kind) VALUES ('DM', 'dm', 'group')
		 RETURNING id`,
	).Scan(&channelID)
	if err != nil {
		log.Error().Err(err).Msg("failed to create DM channel")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Add the creator
	_, err = tx.Exec(r.Context(),
		`INSERT INTO dm_members (channel_id, user_id) VALUES ($1, $2)`,
		channelID, userID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to add DM member (creator)")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Add recipients, de-duplicated and excluding the creator (already a member),
	// so a repeated or self recipient does not trip the dm_members primary key
	// and 500 the request.
	seen := map[uuid.UUID]bool{userID: true}
	added := 0
	for _, rid := range req.RecipientIDs {
		recipientID, err := parseUUID(rid)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid recipient ID"))
			return
		}
		if seen[recipientID] {
			continue
		}
		seen[recipientID] = true
		_, err = tx.Exec(r.Context(),
			`INSERT INTO dm_members (channel_id, user_id) VALUES ($1, $2)`,
			channelID, recipientID,
		)
		if err != nil {
			log.Error().Err(err).Msg("failed to add DM member")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		added++
	}
	if added == 0 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "a DM needs at least one other member"))
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		log.Error().Err(err).Msg("failed to commit transaction")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	ch := h.getDMChannel(r, channelID, userID)
	if ch == nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Subscribe all participants to the new DM channel via WebSocket
	chUUID, err := uuid.Parse(channelID)
	if err == nil {
		h.hub.SubscribeUser(userID, chUUID)
		for _, rid := range req.RecipientIDs {
			recipientUUID, err := uuid.Parse(rid)
			if err == nil {
				h.hub.SubscribeUser(recipientUUID, chUUID)
				// Notify recipient so they can add the DM to their list
				h.hub.BroadcastToUser(recipientUUID, realtime.Event{
					Type: realtime.EventDMCreate,
					Data: h.getDMChannel(r, channelID, recipientUUID),
				})
			}
		}
	}

	writeJSON(w, http.StatusCreated, ch)
}

// createOrGetDirect returns the existing 1:1 DM for (userID, recipient) or
// creates it. Concurrent creates converge on one channel via the unique dm_key:
// the transaction that inserts the row gets 201 and the DM_CREATE fan-out; a
// conflict loser or an already-existing channel gets 200 with no fan-out.
func (h *DMHandler) createOrGetDirect(w http.ResponseWriter, r *http.Request, userID uuid.UUID, recipientRaw string) {
	recipientID, err := parseUUID(recipientRaw)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid recipient ID"))
		return
	}
	if recipientID == userID {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "cannot create a DM with yourself"))
		return
	}
	lo, hi := directDMKey(userID, recipientID)

	// Fast path: an existing keyed channel (no group-DM false match).
	if id := h.lookupDirectDM(r, lo, hi); id != "" {
		h.reopenDirect(r, id, userID)
		if ch := h.getDMChannel(r, id, userID); ch != nil {
			writeJSON(w, http.StatusOK, ch)
			return
		}
	}

	tx, err := h.db.Begin(r.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to begin transaction")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var channelID string
	err = tx.QueryRow(r.Context(),
		`INSERT INTO channels (name, type, dm_kind, dm_user_lo, dm_user_hi)
		 VALUES ('DM', 'dm', 'direct', $1, $2) RETURNING id`,
		lo, hi,
	).Scan(&channelID)
	if err != nil {
		// A concurrent create won the race for this pair; return its channel.
		if isUniqueViolation(err) {
			_ = tx.Rollback(r.Context())
			if id := h.lookupDirectDM(r, lo, hi); id != "" {
				h.reopenDirect(r, id, userID)
				if ch := h.getDMChannel(r, id, userID); ch != nil {
					writeJSON(w, http.StatusOK, ch)
					return
				}
			}
		}
		log.Error().Err(err).Msg("failed to create DM channel")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	for _, uid := range []uuid.UUID{userID, recipientID} {
		if _, err = tx.Exec(r.Context(),
			`INSERT INTO dm_members (channel_id, user_id) VALUES ($1, $2)`, channelID, uid); err != nil {
			log.Error().Err(err).Msg("failed to add DM member")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		log.Error().Err(err).Msg("failed to commit transaction")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	ch := h.getDMChannel(r, channelID, userID)
	if ch == nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Only the creating transaction subscribes participants and fans out.
	if chUUID, perr := uuid.Parse(channelID); perr == nil {
		h.hub.SubscribeUser(userID, chUUID)
		h.hub.SubscribeUser(recipientID, chUUID)
		h.hub.BroadcastToUser(recipientID, realtime.Event{
			Type: realtime.EventDMCreate,
			Data: h.getDMChannel(r, channelID, recipientID),
		})
	}

	writeJSON(w, http.StatusCreated, ch)
}

// lookupDirectDM returns the channel id for a canonical direct-DM pair, or "".
func (h *DMHandler) lookupDirectDM(r *http.Request, lo, hi uuid.UUID) string {
	var id string
	if err := h.db.QueryRow(r.Context(),
		`SELECT id FROM channels WHERE dm_user_lo = $1 AND dm_user_hi = $2 AND dm_kind = 'direct'`, lo, hi).Scan(&id); err != nil {
		return ""
	}
	return id
}

// reopenDirect clears the caller's own closed_at so returning to a DM re-opens it.
func (h *DMHandler) reopenDirect(r *http.Request, channelID string, userID uuid.UUID) {
	if _, err := h.db.Exec(r.Context(),
		`UPDATE dm_members SET closed_at = NULL
		 WHERE channel_id = $1 AND user_id = $2 AND closed_at IS NOT NULL`,
		channelID, userID); err != nil {
		log.Error().Err(err).Msg("failed to reopen DM membership")
	}
}

func (h *DMHandler) Close(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	channelID := chi.URLParam(r, "channelID")

	tag, err := h.db.Exec(r.Context(),
		`UPDATE dm_members SET closed_at = NOW()
		 WHERE channel_id = $1 AND user_id = $2 AND closed_at IS NULL`,
		channelID, userID,
	)
	if err != nil || tag.RowsAffected() == 0 {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "DM not found"))
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *DMHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())

	rows, err := h.db.Query(r.Context(),
		`SELECT c.id, c.server_id, c.name, c.topic, c.type, c.position, c.created_at
		 FROM channels c
		 INNER JOIN dm_members dm ON dm.channel_id = c.id
		 WHERE dm.user_id = $1 AND c.type = 'dm' AND dm.closed_at IS NULL
		 ORDER BY c.created_at DESC`, userID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to list DM channels")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer rows.Close()

	channels := make([]models.DMChannel, 0)
	for rows.Next() {
		var ch models.Channel
		if err := rows.Scan(&ch.ID, &ch.ServerID, &ch.Name, &ch.Topic, &ch.Type, &ch.Position, &ch.CreatedAt); err != nil {
			log.Error().Err(err).Msg("failed to scan DM channel")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}

		// Get recipients (other members in this DM)
		recipients, err := h.getRecipients(r, ch.ID.String(), userID)
		if err != nil {
			log.Error().Err(err).Msg("failed to get DM recipients")
			continue
		}

		// Get last message preview
		var lastMsg *models.Message
		var msg models.Message
		var author models.Author
		err = h.db.QueryRow(r.Context(),
			`SELECT m.id, m.channel_id, m.content, m.edited_at, m.created_at,
			        u.id, u.username, u.display_name, u.avatar_url
			 FROM messages m
			 INNER JOIN users u ON u.id = m.author_id
			 WHERE m.channel_id = $1
			 ORDER BY m.created_at DESC LIMIT 1`, ch.ID,
		).Scan(&msg.ID, &msg.ChannelID, &msg.Content, &msg.EditedAt, &msg.CreatedAt,
			&author.ID, &author.Username, &author.DisplayName, &author.AvatarURL)
		if err == nil {
			msg.Author = &author
			lastMsg = &msg
		}

		channels = append(channels, models.DMChannel{
			Channel:     ch,
			Recipients:  recipients,
			LastMessage: lastMsg,
		})
	}

	writeJSON(w, http.StatusOK, channels)
}

func (h *DMHandler) Get(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	channelID := chi.URLParam(r, "channelID")

	// Verify user is a DM member
	var isMember bool
	err := h.db.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM dm_members WHERE channel_id = $1 AND user_id = $2)`,
		channelID, userID,
	).Scan(&isMember)
	if err != nil || !isMember {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you do not have access to this channel"))
		return
	}

	ch := h.getDMChannel(r, channelID, userID)
	if ch != nil {
		writeJSON(w, http.StatusOK, ch)
	} else {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "channel not found"))
	}
}

func (h *DMHandler) getDMChannel(r *http.Request, channelID string, userID interface{}) *models.DMChannel {
	var ch models.Channel
	err := h.db.QueryRow(r.Context(),
		`SELECT id, server_id, name, topic, type, position, created_at
		 FROM channels WHERE id = $1`, channelID,
	).Scan(&ch.ID, &ch.ServerID, &ch.Name, &ch.Topic, &ch.Type, &ch.Position, &ch.CreatedAt)
	if err != nil {
		return nil
	}

	recipients, _ := h.getRecipients(r, channelID, userID)
	return &models.DMChannel{
		Channel:    ch,
		Recipients: recipients,
	}
}

func (h *DMHandler) getRecipients(r *http.Request, channelID string, excludeUserID interface{}) ([]models.Author, error) {
	rows, err := h.db.Query(r.Context(),
		`SELECT u.id, u.username, u.display_name, u.avatar_url
		 FROM dm_members dm
		 INNER JOIN users u ON u.id = dm.user_id
		 WHERE dm.channel_id = $1 AND dm.user_id != $2`,
		channelID, excludeUserID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var recipients []models.Author
	for rows.Next() {
		var a models.Author
		if err := rows.Scan(&a.ID, &a.Username, &a.DisplayName, &a.AvatarURL); err != nil {
			return nil, err
		}
		recipients = append(recipients, a)
	}
	return recipients, rows.Err()
}
