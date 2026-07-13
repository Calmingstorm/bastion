package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/models"
	"github.com/Calmingstorm/bastion/server/internal/permissions"
	"github.com/Calmingstorm/bastion/server/internal/realtime"
)

// BeforeEditUpdateForTest, when non-nil, runs between a message-edit's author
// check and its UPDATE ... RETURNING. Tests use it to delete the row in that
// window (the row-vanished-mid-edit race); it is nil in production.
var BeforeEditUpdateForTest func()

var mentionRegex = regexp.MustCompile(`@([a-zA-Z0-9_-]+)`)

type MessageHandler struct {
	db  *pgxpool.Pool
	hub *realtime.Hub
}

func NewMessageHandler(db *pgxpool.Pool, hub *realtime.Hub) *MessageHandler {
	return &MessageHandler{db: db, hub: hub}
}

type sendMessageRequest struct {
	Content   string         `json:"content"`
	ReplyToID *uuid.UUID     `json:"replyToId,omitempty"`
	Embeds    []models.Embed `json:"embeds,omitempty"`
	CreatedAt *time.Time     `json:"createdAt,omitempty"`
}

type editMessageRequest struct {
	Content string         `json:"content"`
	Embeds  []models.Embed `json:"embeds,omitempty"`
}

func validateEmbeds(embeds []models.Embed) error {
	if len(embeds) > 10 {
		return fmt.Errorf("maximum 10 embeds per message")
	}
	for i := range embeds {
		e := &embeds[i]
		// Normalize URL fields in place so the value that is validated is exactly
		// the value that is persisted — a padded URL cannot pass validation and
		// then be stored (and rendered) with its surrounding whitespace.
		e.URL = strings.TrimSpace(e.URL)
		if e.Image != nil {
			e.Image.URL = strings.TrimSpace(e.Image.URL)
		}
		if e.Thumbnail != nil {
			e.Thumbnail.URL = strings.TrimSpace(e.Thumbnail.URL)
		}

		total := len(e.Title) + len(e.Description)
		if e.Footer != nil {
			total += len(e.Footer.Text)
		}
		for _, f := range e.Fields {
			total += len(f.Name) + len(f.Value)
		}
		if total > 6000 {
			return fmt.Errorf("embed %d exceeds 6000 character limit", i)
		}
		if len(e.Fields) > 25 {
			return fmt.Errorf("embed %d exceeds 25 field limit", i)
		}
		// URL fields must be http(s) so a stored javascript:/data: URL cannot
		// execute when a client renders the embed.
		if !embedURLOK(e.URL) {
			return fmt.Errorf("embed %d has an invalid url", i)
		}
		if e.Image != nil && !embedURLOK(e.Image.URL) {
			return fmt.Errorf("embed %d image has an invalid url", i)
		}
		if e.Thumbnail != nil && !embedURLOK(e.Thumbnail.URL) {
			return fmt.Errorf("embed %d thumbnail has an invalid url", i)
		}
	}
	return nil
}

// isHTTPURL reports whether s is a syntactically valid absolute http(s) URL with
// a hostname. A bare scheme ("http:", "https://"), an opaque value
// ("https:javascript:alert(1)"), a hostless path, or a port-only authority
// ("https://:443") is rejected — only a real http(s) target passes.
func isHTTPURL(s string) bool {
	u, err := url.Parse(strings.TrimSpace(s))
	if err != nil {
		return false
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https":
		return u.Hostname() != ""
	default:
		return false
	}
}

// embedURLOK reports whether an optional embed URL field is empty or http(s).
func embedURLOK(s string) bool {
	if strings.TrimSpace(s) == "" {
		return true
	}
	return isHTTPURL(s)
}

func (h *MessageHandler) checkChannelAccess(r *http.Request, channelID, userID uuid.UUID) bool {
	var isMember bool
	err := h.db.QueryRow(r.Context(),
		`SELECT EXISTS(
			SELECT 1 FROM server_members sm
			INNER JOIN channels c ON c.server_id = sm.server_id
			WHERE c.id = $1 AND sm.user_id = $2
			UNION ALL
			SELECT 1 FROM dm_members dm
			WHERE dm.channel_id = $1 AND dm.user_id = $2
		)`, channelID, userID,
	).Scan(&isMember)
	return err == nil && isMember
}

// requireChannelPermission enforces a server-level permission bit for a channel.
// DM channels (which have no server) are governed by membership alone and always
// pass. It assumes channel membership has already been verified, and fails closed
// on any lookup error. On denial it writes a 4xx and returns false.
//
// Note: this enforces server-level permissions only. Bastion's per-channel
// override table and permissions.ComputeChannel remain unwired, so genuinely
// channel-specific restrictions are not yet enforceable here.
func requireChannelPermission(db *pgxpool.Pool, w http.ResponseWriter, r *http.Request, channelID, userID uuid.UUID, perm int64) bool {
	var serverID *uuid.UUID
	if err := db.QueryRow(r.Context(),
		`SELECT server_id FROM channels WHERE id = $1`, channelID,
	).Scan(&serverID); err != nil {
		// Fail closed: if we cannot resolve the channel, deny rather than allow.
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "channel not found"))
		return false
	}
	if serverID == nil {
		return true // DM channel: membership is the only gate
	}
	perms, err := getMemberPermissions(db, r, *serverID, userID)
	if err != nil {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "not a member of this server"))
		return false
	}
	if !permissions.Has(perms, perm) {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you do not have permission to do that in this channel"))
		return false
	}
	return true
}

// subscribeViewable subscribes the user's WebSocket clients to the given
// channels, but only those the user may currently view — so joining (even with
// an already-connected socket) never subscribes to a hidden channel.
func subscribeViewable(ctx context.Context, db *pgxpool.Pool, hub *realtime.Hub, userID uuid.UUID, channelIDs []uuid.UUID) {
	viewable, err := realtime.ViewableChannelIDs(ctx, db, userID)
	if err != nil {
		return
	}
	set := make(map[uuid.UUID]bool, len(viewable))
	for _, id := range viewable {
		set[id] = true
	}
	for _, chID := range channelIDs {
		if set[chID] {
			hub.SubscribeUser(userID, chID)
		}
	}
}

// reconcileServerSubscriptions makes a user's live WebSocket subscriptions for a
// server's channels match what they may currently view. Called after a role
// change so a member who just lost (or gained) ViewChannel stops (or starts)
// receiving that channel's realtime events without needing to reconnect.
func reconcileServerSubscriptions(ctx context.Context, db *pgxpool.Pool, hub *realtime.Hub, userID, serverID uuid.UUID) {
	if !hub.IsUserOnline(userID) {
		return
	}
	channelIDs, err := getServerChannelIDs(ctx, db, serverID)
	if err != nil {
		return
	}
	viewable, err := realtime.ViewableChannelIDs(ctx, db, userID)
	if err != nil {
		return
	}
	view := make(map[uuid.UUID]bool, len(viewable))
	for _, id := range viewable {
		view[id] = true
	}
	// Every hub mutation is synchronous, so when this returns a revoked member is
	// already off the channel and no later broadcast can reach them — and no
	// pending queued subscribe can drain afterward to resurrect access.
	for _, chID := range channelIDs {
		if view[chID] {
			hub.SubscribeUser(userID, chID)
		} else {
			hub.UnsubscribeUser(userID, chID)
		}
	}
}

// roleMemberIDs returns the user IDs of every member currently holding a role.
func roleMemberIDs(ctx context.Context, db *pgxpool.Pool, serverID, roleID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := db.Query(ctx,
		`SELECT user_id FROM member_roles WHERE server_id = $1 AND role_id = $2`, serverID, roleID)
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

// reconcileMembersSubscriptions reconciles live subscriptions for a set of members
// after a role's permissions change (or the role is deleted), which can flip
// channel visibility for many members at once.
func reconcileMembersSubscriptions(ctx context.Context, db *pgxpool.Pool, hub *realtime.Hub, serverID uuid.UUID, memberIDs []uuid.UUID) {
	for _, uid := range memberIDs {
		reconcileServerSubscriptions(ctx, db, hub, uid, serverID)
	}
}

func (h *MessageHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	channelID, err := parseUUID(chi.URLParam(r, "channelID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid channel ID"))
		return
	}

	if !h.checkChannelAccess(r, channelID, userID) {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you do not have access to this channel"))
		return
	}
	if !requireChannelPermission(h.db, w, r, channelID, userID, permissions.ViewChannel) {
		return
	}

	// Cursor-based pagination: fetch messages before a given message's timestamp
	beforeParam := r.URL.Query().Get("before")
	limit := 50

	var rows pgx.Rows

	baseQuery := `SELECT m.id, m.channel_id, m.content, m.edited_at, m.created_at,
		 u.id, u.username, u.display_name, u.avatar_url, u.is_bot,
		 m.reply_to_id, rm.id, rm.content, ru.id, ru.username, ru.display_name, ru.avatar_url,
		 m.embeds, m.author_override
		 FROM messages m
		 INNER JOIN users u ON u.id = m.author_id
		 LEFT JOIN messages rm ON rm.id = m.reply_to_id
		 LEFT JOIN users ru ON ru.id = rm.author_id
		 WHERE m.channel_id = $1`

	if beforeParam != "" {
		beforeID, err := uuid.Parse(beforeParam)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid before cursor"))
			return
		}

		// Get the created_at of the cursor message
		var cursorTime time.Time
		err = h.db.QueryRow(r.Context(),
			`SELECT created_at FROM messages WHERE id = $1`, beforeID,
		).Scan(&cursorTime)
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "cursor message not found"))
			return
		} else if err != nil {
			log.Error().Err(err).Msg("failed to read cursor message")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}

		rows, err = h.db.Query(r.Context(),
			baseQuery+` AND m.created_at < $2 ORDER BY m.created_at DESC LIMIT $3`,
			channelID, cursorTime, limit,
		)
		if err != nil {
			log.Error().Err(err).Msg("failed to list messages")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
	} else {
		rows, err = h.db.Query(r.Context(),
			baseQuery+` ORDER BY m.created_at DESC LIMIT $2`,
			channelID, limit,
		)
		if err != nil {
			log.Error().Err(err).Msg("failed to list messages")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
	}
	defer rows.Close()

	messages := make([]models.Message, 0)
	messageIDs := make([]uuid.UUID, 0)
	for rows.Next() {
		var msg models.Message
		var author models.Author
		var replyToID *uuid.UUID
		var replyID, replyAuthorID *uuid.UUID
		var replyContent, replyUsername *string
		var replyDisplayName, replyAvatarURL *string
		var embedsJSON, authorOverrideJSON []byte
		if err := rows.Scan(&msg.ID, &msg.ChannelID, &msg.Content, &msg.EditedAt, &msg.CreatedAt,
			&author.ID, &author.Username, &author.DisplayName, &author.AvatarURL, &author.IsBot,
			&replyToID, &replyID, &replyContent, &replyAuthorID, &replyUsername, &replyDisplayName, &replyAvatarURL,
			&embedsJSON, &authorOverrideJSON); err != nil {
			log.Error().Err(err).Msg("failed to scan message")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		msg.Author = &author
		if len(embedsJSON) > 0 {
			json.Unmarshal(embedsJSON, &msg.Embeds)
		}
		if len(authorOverrideJSON) > 0 {
			json.Unmarshal(authorOverrideJSON, &msg.AuthorOverride)
		}
		msg.ReplyToID = replyToID
		if replyID != nil && replyContent != nil && replyAuthorID != nil && replyUsername != nil {
			// Truncate reply content to 100 chars
			content := *replyContent
			if len(content) > 100 {
				content = content[:100] + "..."
			}
			msg.ReplyTo = &models.ReplyInfo{
				ID:      *replyID,
				Content: content,
				Author: models.Author{
					ID:          *replyAuthorID,
					Username:    *replyUsername,
					DisplayName: replyDisplayName,
					AvatarURL:   replyAvatarURL,
				},
			}
		}
		messageIDs = append(messageIDs, msg.ID)
		messages = append(messages, msg)
	}

	if err := rows.Err(); err != nil {
		log.Error().Err(err).Msg("rows iteration error")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Bulk-fetch reactions for all messages
	if len(messageIDs) > 0 {
		reactionRows, err := h.db.Query(r.Context(),
			`SELECT message_id, emoji, array_agg(user_id::text), COUNT(*)
			 FROM message_reactions WHERE message_id = ANY($1)
			 GROUP BY message_id, emoji ORDER BY MIN(created_at)`,
			messageIDs,
		)
		if err == nil {
			defer reactionRows.Close()
			reactionMap := make(map[uuid.UUID][]models.Reaction)
			for reactionRows.Next() {
				var messageID uuid.UUID
				var emoji string
				var users []string
				var count int
				if err := reactionRows.Scan(&messageID, &emoji, &users, &count); err == nil {
					reactionMap[messageID] = append(reactionMap[messageID], models.Reaction{
						Emoji: emoji,
						Count: count,
						Users: users,
					})
				}
			}
			for i := range messages {
				if reactions, ok := reactionMap[messages[i].ID]; ok {
					messages[i].Reactions = reactions
				}
			}
		}
	}

	writeJSON(w, http.StatusOK, messages)
}

func (h *MessageHandler) Send(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	channelID, err := parseUUID(chi.URLParam(r, "channelID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid channel ID"))
		return
	}

	if !h.checkChannelAccess(r, channelID, userID) {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you do not have access to this channel"))
		return
	}

	// Check if user is timed out in this server
	var serverID *uuid.UUID
	h.db.QueryRow(r.Context(), `SELECT server_id FROM channels WHERE id = $1`, channelID).Scan(&serverID)
	if serverID != nil {
		var timedOutUntil *time.Time
		err := h.db.QueryRow(r.Context(),
			`SELECT timed_out_until FROM server_members WHERE server_id = $1 AND user_id = $2`,
			*serverID, userID,
		).Scan(&timedOutUntil)
		if err == nil && timedOutUntil != nil && timedOutUntil.After(time.Now()) {
			writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you are timed out in this server"))
			return
		}
	}

	if !requireChannelPermission(h.db, w, r, channelID, userID, permissions.SendMessages) {
		return
	}

	var req sendMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	req.Content = strings.TrimSpace(req.Content)
	if req.Content == "" && len(req.Embeds) == 0 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "message must have content or embeds"))
		return
	}
	if len(req.Content) > 4000 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "message content cannot exceed 4000 characters"))
		return
	}
	if len(req.Embeds) > 0 {
		if err := validateEmbeds(req.Embeds); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", err.Error()))
			return
		}
	}

	// Timestamp override (bot-only)
	if req.CreatedAt != nil {
		if !auth.IsBotFromContext(r.Context()) {
			writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "only bots can set createdAt"))
			return
		}
		if req.CreatedAt.After(time.Now().Add(time.Minute)) {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "createdAt cannot be in the future"))
			return
		}
	}

	// Validate reply reference if provided
	if req.ReplyToID != nil {
		var replyExists bool
		err := h.db.QueryRow(r.Context(),
			`SELECT EXISTS(SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2)`,
			*req.ReplyToID, channelID,
		).Scan(&replyExists)
		if err != nil || !replyExists {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "referenced message not found in this channel"))
			return
		}
	}

	var embedsJSON []byte
	if len(req.Embeds) > 0 {
		embedsJSON, _ = json.Marshal(req.Embeds)
	}

	var msg models.Message
	var author models.Author
	err = h.db.QueryRow(r.Context(),
		`WITH new_msg AS (
			INSERT INTO messages (channel_id, author_id, content, reply_to_id, embeds, created_at)
			VALUES ($1, $2, $3, $4, $5, COALESCE($6, NOW()))
			RETURNING id, channel_id, author_id, content, edited_at, reply_to_id, embeds, created_at
		)
		SELECT m.id, m.channel_id, m.content, m.edited_at, m.reply_to_id, m.created_at,
			   u.id, u.username, u.display_name, u.avatar_url, u.is_bot, m.embeds
		FROM new_msg m
		INNER JOIN users u ON u.id = m.author_id`,
		channelID, userID, req.Content, req.ReplyToID, embedsJSON, req.CreatedAt,
	).Scan(&msg.ID, &msg.ChannelID, &msg.Content, &msg.EditedAt, &msg.ReplyToID, &msg.CreatedAt,
		&author.ID, &author.Username, &author.DisplayName, &author.AvatarURL, &author.IsBot, &embedsJSON)
	if err != nil {
		log.Error().Err(err).Msg("failed to insert message")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	msg.Author = &author
	if len(embedsJSON) > 0 {
		json.Unmarshal(embedsJSON, &msg.Embeds)
	}

	// Populate reply info if this is a reply
	if msg.ReplyToID != nil {
		var reply models.ReplyInfo
		err := h.db.QueryRow(r.Context(),
			`SELECT m.id, m.content, u.id, u.username, u.display_name, u.avatar_url
			 FROM messages m INNER JOIN users u ON u.id = m.author_id WHERE m.id = $1`,
			*msg.ReplyToID,
		).Scan(&reply.ID, &reply.Content, &reply.Author.ID, &reply.Author.Username, &reply.Author.DisplayName, &reply.Author.AvatarURL)
		if err == nil {
			if len(reply.Content) > 100 {
				reply.Content = reply.Content[:100] + "..."
			}
			msg.ReplyTo = &reply
		}
	}

	// For DM channels, reopen for any members who closed the conversation
	// (must happen BEFORE broadcast so frontend refetch sees the reopened DM)
	if serverID == nil {
		h.db.Exec(r.Context(),
			`UPDATE dm_members SET closed_at = NULL WHERE channel_id = $1 AND closed_at IS NOT NULL`,
			channelID,
		)
	}

	// Broadcast to WebSocket subscribers
	h.hub.BroadcastToChannel(channelID, realtime.Event{
		Type: realtime.EventMessageCreate,
		Data: msg,
	})

	// Process @mentions (only for server channels, not DMs)
	if serverID != nil {
		h.processMentions(r, *serverID, channelID, userID, req.Content)
	}

	writeJSON(w, http.StatusCreated, msg)
}

func (h *MessageHandler) Edit(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	channelID, err := parseUUID(chi.URLParam(r, "channelID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid channel ID"))
		return
	}
	messageID, err := parseUUID(chi.URLParam(r, "messageID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid message ID"))
		return
	}

	// Verify message exists and user is the author
	var authorID uuid.UUID
	err = h.db.QueryRow(r.Context(),
		`SELECT author_id FROM messages WHERE id = $1 AND channel_id = $2`,
		messageID, channelID,
	).Scan(&authorID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "message not found"))
		return
	}
	if authorID != userID {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you can only edit your own messages"))
		return
	}
	// Editing requires being able to send in the channel, so a member who has
	// lost SendMessages (or ViewChannel) cannot modify content there.
	if !requireChannelPermission(h.db, w, r, channelID, userID, permissions.SendMessages) {
		return
	}

	var req editMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	req.Content = strings.TrimSpace(req.Content)
	if req.Content == "" && len(req.Embeds) == 0 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "message must have content or embeds"))
		return
	}
	if len(req.Content) > 4000 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "message content cannot exceed 4000 characters"))
		return
	}
	if len(req.Embeds) > 0 {
		if err := validateEmbeds(req.Embeds); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", err.Error()))
			return
		}
	}

	var editEmbedsJSON []byte
	if len(req.Embeds) > 0 {
		editEmbedsJSON, _ = json.Marshal(req.Embeds)
	}

	if BeforeEditUpdateForTest != nil {
		BeforeEditUpdateForTest()
	}

	var msg models.Message
	var author models.Author
	var returnedEmbedsJSON []byte
	err = h.db.QueryRow(r.Context(),
		`UPDATE messages SET content = $1, embeds = $3, edited_at = NOW()
		 WHERE id = $2
		 RETURNING id, channel_id, content, edited_at, created_at, embeds,
			(SELECT u.id FROM users u WHERE u.id = author_id),
			(SELECT u.username FROM users u WHERE u.id = author_id),
			(SELECT u.display_name FROM users u WHERE u.id = author_id),
			(SELECT u.avatar_url FROM users u WHERE u.id = author_id),
			(SELECT u.is_bot FROM users u WHERE u.id = author_id)`,
		req.Content, messageID, editEmbedsJSON,
	).Scan(&msg.ID, &msg.ChannelID, &msg.Content, &msg.EditedAt, &msg.CreatedAt, &returnedEmbedsJSON,
		&author.ID, &author.Username, &author.DisplayName, &author.AvatarURL, &author.IsBot)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "message not found"))
		return
	} else if err != nil {
		log.Error().Err(err).Msg("failed to update message")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	msg.Author = &author
	if len(returnedEmbedsJSON) > 0 {
		json.Unmarshal(returnedEmbedsJSON, &msg.Embeds)
	}

	h.hub.BroadcastToChannel(channelID, realtime.Event{
		Type: realtime.EventMessageUpdate,
		Data: msg,
	})

	writeJSON(w, http.StatusOK, msg)
}

func (h *MessageHandler) Delete(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	channelID, err := parseUUID(chi.URLParam(r, "channelID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid channel ID"))
		return
	}
	messageID, err := parseUUID(chi.URLParam(r, "messageID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid message ID"))
		return
	}

	// Verify message exists, get author and channel's server
	var authorID uuid.UUID
	var serverID *uuid.UUID
	err = h.db.QueryRow(r.Context(),
		`SELECT m.author_id, c.server_id
		 FROM messages m
		 INNER JOIN channels c ON c.id = m.channel_id
		 WHERE m.id = $1 AND m.channel_id = $2`,
		messageID, channelID,
	).Scan(&authorID, &serverID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "message not found"))
		return
	}

	// Allow deletion if author OR has MANAGE_MESSAGES permission
	if authorID != userID {
		if serverID == nil {
			writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you can only delete your own messages"))
			return
		}
		perms, err := getMemberPermissions(h.db, r, *serverID, userID)
		if err != nil || !permissions.Has(perms, permissions.ManageMessages) {
			writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you can only delete your own messages"))
			return
		}
	}

	// Deleting (as author or moderator) requires being able to view the channel,
	// so a member who lost ViewChannel cannot mutate a hidden channel by known ID.
	if !requireChannelPermission(h.db, w, r, channelID, userID, permissions.ViewChannel) {
		return
	}

	_, err = h.db.Exec(r.Context(),
		`DELETE FROM messages WHERE id = $1`, messageID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to delete message")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	h.hub.BroadcastToChannel(channelID, realtime.Event{
		Type: realtime.EventMessageDelete,
		Data: map[string]string{
			"channelId": channelID.String(),
			"messageId": messageID.String(),
		},
	})

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// processMentions parses @mentions from message content and sends notifications.
func (h *MessageHandler) processMentions(r *http.Request, serverID, channelID, authorID uuid.UUID, content string) {
	matches := mentionRegex.FindAllStringSubmatch(content, -1)
	if len(matches) == 0 {
		return
	}

	// Fetch sender username and channel name for notification payload
	var senderName string
	_ = h.db.QueryRow(r.Context(), `SELECT username FROM users WHERE id = $1`, authorID).Scan(&senderName)
	var channelName string
	_ = h.db.QueryRow(r.Context(), `SELECT name FROM channels WHERE id = $1`, channelID).Scan(&channelName)

	// Truncate content for notification snippet
	snippet := content
	if len(snippet) > 100 {
		snippet = snippet[:100]
	}

	// Collect unique mentioned usernames
	mentionedNames := make(map[string]struct{})
	mentionAll := false
	for _, m := range matches {
		name := strings.ToLower(m[1])
		if name == "bastion" {
			mentionAll = true
		} else {
			mentionedNames[name] = struct{}{}
		}
	}

	// Get all server members
	rows, err := h.db.Query(r.Context(),
		`SELECT sm.user_id, u.username FROM server_members sm
		 INNER JOIN users u ON u.id = sm.user_id
		 WHERE sm.server_id = $1`, serverID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to query members for mentions")
		return
	}
	defer rows.Close()

	type memberInfo struct {
		id       uuid.UUID
		username string
	}
	var members []memberInfo
	for rows.Next() {
		var m memberInfo
		if err := rows.Scan(&m.id, &m.username); err != nil {
			continue
		}
		members = append(members, m)
	}

	// Determine who to notify
	notifySet := make(map[uuid.UUID]struct{})
	if mentionAll {
		// @bastion: notify all server members except author
		for _, m := range members {
			if m.id != authorID {
				notifySet[m.id] = struct{}{}
			}
		}
	}
	// Individual @username mentions
	for _, m := range members {
		if _, ok := mentionedNames[strings.ToLower(m.username)]; ok && m.id != authorID {
			notifySet[m.id] = struct{}{}
		}
	}

	// Send notifications
	for uid := range notifySet {
		// A mention must not leak a hidden channel: skip members who cannot view
		// the channel (its name and a content snippet ride in the notification).
		if perms, permErr := getMemberPermissions(h.db, r, serverID, uid); permErr != nil || !permissions.Has(perms, permissions.ViewChannel) {
			continue
		}

		// Increment mention count in read_states
		_, err := h.db.Exec(r.Context(),
			`INSERT INTO read_states (user_id, channel_id, mention_count)
			 VALUES ($1, $2, 1)
			 ON CONFLICT (user_id, channel_id) DO UPDATE SET mention_count = read_states.mention_count + 1`,
			uid, channelID,
		)
		if err != nil {
			log.Error().Err(err).Msg("failed to increment mention count")
		}

		// Notify via WebSocket
		h.hub.BroadcastToUser(uid, realtime.Event{
			Type: realtime.EventNotification,
			Data: map[string]any{
				"channelId":    channelID.String(),
				"mentionCount": 1,
				"senderName":   senderName,
				"channelName":  channelName,
				"content":      snippet,
			},
		})
	}
}

// BulkImport handles POST /channels/{channelID}/import (bot-only)
func (h *MessageHandler) BulkImport(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	channelID, err := parseUUID(chi.URLParam(r, "channelID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid channel ID"))
		return
	}

	if !auth.IsBotFromContext(r.Context()) {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "bulk import is only available to bots"))
		return
	}

	if !h.checkChannelAccess(r, channelID, userID) {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you do not have access to this channel"))
		return
	}
	if !requireChannelPermission(h.db, w, r, channelID, userID, permissions.SendMessages) {
		return
	}

	type importMessage struct {
		Content        string                 `json:"content"`
		Embeds         []models.Embed         `json:"embeds,omitempty"`
		CreatedAt      *time.Time             `json:"createdAt,omitempty"`
		AuthorOverride *models.AuthorOverride `json:"authorOverride,omitempty"`
	}

	var msgs []importMessage
	if err := json.NewDecoder(r.Body).Decode(&msgs); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	if len(msgs) == 0 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "at least one message is required"))
		return
	}
	if len(msgs) > 50 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "maximum 50 messages per import"))
		return
	}

	// Validate all messages
	for i, m := range msgs {
		if m.Content == "" && len(m.Embeds) == 0 {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", fmt.Sprintf("message %d must have content or embeds", i)))
			return
		}
		if len(m.Content) > 4000 {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", fmt.Sprintf("message %d content exceeds 4000 characters", i)))
			return
		}
		if len(m.Embeds) > 0 {
			if err := validateEmbeds(m.Embeds); err != nil {
				writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", fmt.Sprintf("message %d: %s", i, err.Error())))
				return
			}
		}
		if m.CreatedAt != nil && m.CreatedAt.After(time.Now().Add(time.Minute)) {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", fmt.Sprintf("message %d createdAt cannot be in the future", i)))
			return
		}
	}

	tx, err := h.db.Begin(r.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to begin bulk import transaction")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer tx.Rollback(r.Context())

	// Fetch author info once
	var author models.Author
	err = tx.QueryRow(r.Context(),
		`SELECT id, username, display_name, avatar_url, is_bot FROM users WHERE id = $1`, userID,
	).Scan(&author.ID, &author.Username, &author.DisplayName, &author.AvatarURL, &author.IsBot)
	if err != nil {
		log.Error().Err(err).Msg("failed to fetch bot user")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	result := make([]models.Message, 0, len(msgs))
	for _, m := range msgs {
		var embedsJSON, authorOverrideJSON []byte
		if len(m.Embeds) > 0 {
			embedsJSON, _ = json.Marshal(m.Embeds)
		}
		if m.AuthorOverride != nil {
			authorOverrideJSON, _ = json.Marshal(m.AuthorOverride)
		}

		var msg models.Message
		var returnedEmbeds, returnedOverride []byte
		err = tx.QueryRow(r.Context(),
			`INSERT INTO messages (channel_id, author_id, content, embeds, author_override, created_at)
			 VALUES ($1, $2, $3, $4, $5, COALESCE($6, NOW()))
			 RETURNING id, channel_id, content, edited_at, embeds, author_override, created_at`,
			channelID, userID, m.Content, embedsJSON, authorOverrideJSON, m.CreatedAt,
		).Scan(&msg.ID, &msg.ChannelID, &msg.Content, &msg.EditedAt, &returnedEmbeds, &returnedOverride, &msg.CreatedAt)
		if err != nil {
			log.Error().Err(err).Msg("failed to insert imported message")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}

		msg.Author = &author
		if len(returnedEmbeds) > 0 {
			json.Unmarshal(returnedEmbeds, &msg.Embeds)
		}
		if len(returnedOverride) > 0 {
			json.Unmarshal(returnedOverride, &msg.AuthorOverride)
		}
		result = append(result, msg)
	}

	if err := tx.Commit(r.Context()); err != nil {
		log.Error().Err(err).Msg("failed to commit bulk import")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	// Broadcast all imported messages
	for _, msg := range result {
		h.hub.BroadcastToChannel(channelID, realtime.Event{
			Type: realtime.EventMessageCreate,
			Data: msg,
		})
	}

	writeJSON(w, http.StatusCreated, result)
}
