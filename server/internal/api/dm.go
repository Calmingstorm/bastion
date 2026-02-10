package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/models"
)

type DMHandler struct {
	db *pgxpool.Pool
}

func NewDMHandler(db *pgxpool.Pool) *DMHandler {
	return &DMHandler{db: db}
}

type createDMRequest struct {
	RecipientIDs []string `json:"recipientIds"`
}

func (h *DMHandler) CreateOrGet(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())

	var req createDMRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))
		return
	}

	if len(req.RecipientIDs) == 0 || len(req.RecipientIDs) > 9 {
		writeJSON(w, http.StatusBadRequest, errorBody("1-9 recipients required"))
		return
	}

	// For 1:1 DMs, check if one already exists
	if len(req.RecipientIDs) == 1 {
		recipientID, err := parseUUID(req.RecipientIDs[0])
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("invalid recipient ID"))
			return
		}

		// Find existing DM between these two users
		var existingChannelID *string
		err = h.db.QueryRow(r.Context(),
			`SELECT dm1.channel_id
			 FROM dm_members dm1
			 INNER JOIN dm_members dm2 ON dm1.channel_id = dm2.channel_id
			 INNER JOIN channels c ON c.id = dm1.channel_id
			 WHERE dm1.user_id = $1 AND dm2.user_id = $2 AND c.type = 'dm'
			 LIMIT 1`,
			userID, recipientID,
		).Scan(&existingChannelID)

		if existingChannelID != nil {
			// Return existing DM channel with recipients
			ch := h.getDMChannel(r, *existingChannelID, userID)
			if ch != nil {
				writeJSON(w, http.StatusOK, ch)
				return
			}
		}
	}

	// Create new DM channel
	tx, err := h.db.Begin(r.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to begin transaction")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}
	defer tx.Rollback(r.Context())

	var channelID string
	err = tx.QueryRow(r.Context(),
		`INSERT INTO channels (name, type) VALUES ('DM', 'dm')
		 RETURNING id`,
	).Scan(&channelID)
	if err != nil {
		log.Error().Err(err).Msg("failed to create DM channel")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	// Add the creator
	_, err = tx.Exec(r.Context(),
		`INSERT INTO dm_members (channel_id, user_id) VALUES ($1, $2)`,
		channelID, userID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to add DM member (creator)")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	// Add recipients
	for _, rid := range req.RecipientIDs {
		recipientID, err := parseUUID(rid)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("invalid recipient ID"))
			return
		}
		_, err = tx.Exec(r.Context(),
			`INSERT INTO dm_members (channel_id, user_id) VALUES ($1, $2)`,
			channelID, recipientID,
		)
		if err != nil {
			log.Error().Err(err).Msg("failed to add DM member")
			writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
			return
		}
	}

	if err := tx.Commit(r.Context()); err != nil {
		log.Error().Err(err).Msg("failed to commit transaction")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	ch := h.getDMChannel(r, channelID, userID)
	if ch != nil {
		writeJSON(w, http.StatusCreated, ch)
	} else {
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
	}
}

func (h *DMHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())

	rows, err := h.db.Query(r.Context(),
		`SELECT c.id, c.server_id, c.name, c.topic, c.type, c.position, c.created_at
		 FROM channels c
		 INNER JOIN dm_members dm ON dm.channel_id = c.id
		 WHERE dm.user_id = $1 AND c.type = 'dm'
		 ORDER BY c.created_at DESC`, userID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to list DM channels")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}
	defer rows.Close()

	channels := make([]models.DMChannel, 0)
	for rows.Next() {
		var ch models.Channel
		if err := rows.Scan(&ch.ID, &ch.ServerID, &ch.Name, &ch.Topic, &ch.Type, &ch.Position, &ch.CreatedAt); err != nil {
			log.Error().Err(err).Msg("failed to scan DM channel")
			writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
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
		writeJSON(w, http.StatusForbidden, errorBody("you do not have access to this channel"))
		return
	}

	ch := h.getDMChannel(r, channelID, userID)
	if ch != nil {
		writeJSON(w, http.StatusOK, ch)
	} else {
		writeJSON(w, http.StatusNotFound, errorBody("channel not found"))
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
