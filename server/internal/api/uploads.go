package api

import (
	"net/http"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/config"
	"github.com/Calmingstorm/bastion/server/internal/models"
	"github.com/Calmingstorm/bastion/server/internal/realtime"
	"github.com/Calmingstorm/bastion/server/internal/storage"
)

type UploadHandler struct {
	db      *pgxpool.Pool
	hub     *realtime.Hub
	storage *storage.FileStorage
	cfg     *config.Config
}

func NewUploadHandler(db *pgxpool.Pool, hub *realtime.Hub, storage *storage.FileStorage, cfg *config.Config) *UploadHandler {
	return &UploadHandler{db: db, hub: hub, storage: storage, cfg: cfg}
}

func (h *UploadHandler) SendWithAttachments(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	channelID, err := parseUUID(chi.URLParam(r, "channelID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid channel ID"))
		return
	}

	// Check channel access using the shared helper
	msgHandler := &MessageHandler{db: h.db, hub: h.hub}
	if !msgHandler.checkChannelAccess(r, channelID, userID) {
		writeJSON(w, http.StatusForbidden, errorBody("you do not have access to this channel"))
		return
	}

	// Parse multipart form
	r.Body = http.MaxBytesReader(w, r.Body, h.cfg.Upload.MaxFileSize+1024*1024) // extra 1MB for text fields
	if err := r.ParseMultipartForm(h.cfg.Upload.MaxFileSize); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("request too large"))
		return
	}

	content := strings.TrimSpace(r.FormValue("content"))

	// Get files
	files := r.MultipartForm.File["files"]
	if len(files) == 0 && content == "" {
		writeJSON(w, http.StatusBadRequest, errorBody("message must have content or attachments"))
		return
	}
	if len(files) > 10 {
		writeJSON(w, http.StatusBadRequest, errorBody("maximum 10 attachments per message"))
		return
	}
	if content == "" {
		content = " " // empty content placeholder when only files
	}
	if len(content) > 4000 {
		writeJSON(w, http.StatusBadRequest, errorBody("message content cannot exceed 4000 characters"))
		return
	}

	// Begin transaction
	tx, err := h.db.Begin(r.Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to begin transaction")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}
	defer tx.Rollback(r.Context())

	// Insert message
	var msg models.Message
	var author models.Author
	err = tx.QueryRow(r.Context(),
		`WITH new_msg AS (
			INSERT INTO messages (channel_id, author_id, content)
			VALUES ($1, $2, $3)
			RETURNING id, channel_id, author_id, content, edited_at, created_at
		)
		SELECT m.id, m.channel_id, m.content, m.edited_at, m.created_at,
			   u.id, u.username, u.display_name, u.avatar_url
		FROM new_msg m
		INNER JOIN users u ON u.id = m.author_id`,
		channelID, userID, content,
	).Scan(&msg.ID, &msg.ChannelID, &msg.Content, &msg.EditedAt, &msg.CreatedAt,
		&author.ID, &author.Username, &author.DisplayName, &author.AvatarURL)
	if err != nil {
		log.Error().Err(err).Msg("failed to insert message")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}
	msg.Author = &author

	// Process file uploads
	attachments := make([]models.Attachment, 0, len(files))
	for _, fh := range files {
		if fh.Size > h.cfg.Upload.MaxFileSize {
			writeJSON(w, http.StatusBadRequest, errorBody("file too large"))
			return
		}

		file, err := fh.Open()
		if err != nil {
			log.Error().Err(err).Msg("failed to open uploaded file")
			writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
			return
		}

		ext := filepath.Ext(fh.Filename)
		storedName, url, err := h.storage.Save(file, ext)
		file.Close()
		if err != nil {
			log.Error().Err(err).Msg("failed to save file")
			writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
			return
		}

		contentType := fh.Header.Get("Content-Type")
		if contentType == "" {
			contentType = "application/octet-stream"
		}

		var att models.Attachment
		err = tx.QueryRow(r.Context(),
			`INSERT INTO attachments (message_id, filename, stored_name, content_type, size, url)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 RETURNING id, message_id, filename, stored_name, content_type, size, url, created_at`,
			msg.ID, fh.Filename, storedName, contentType, fh.Size, url,
		).Scan(&att.ID, &att.MessageID, &att.Filename, &att.StoredName,
			&att.ContentType, &att.Size, &att.URL, &att.CreatedAt)
		if err != nil {
			log.Error().Err(err).Msg("failed to insert attachment")
			writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
			return
		}
		attachments = append(attachments, att)
	}

	if err := tx.Commit(r.Context()); err != nil {
		log.Error().Err(err).Msg("failed to commit transaction")
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}

	msg.Attachments = attachments

	// Broadcast
	h.hub.BroadcastToChannel(channelID, realtime.Event{
		Type: realtime.EventMessageCreate,
		Data: msg,
	})

	writeJSON(w, http.StatusCreated, msg)
}
