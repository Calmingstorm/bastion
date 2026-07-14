package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/config"
	"github.com/Calmingstorm/bastion/server/internal/models"
	"github.com/Calmingstorm/bastion/server/internal/permissions"
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
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid channel ID"))
		return
	}

	// Check channel access using the shared helper
	msgHandler := &MessageHandler{db: h.db, hub: h.hub}
	if !msgHandler.checkChannelAccess(r, channelID, userID) {
		writeJSON(w, http.StatusForbidden, errorResponse("FORBIDDEN", "you do not have access to this channel"))
		return
	}

	// Parse multipart form
	r.Body = http.MaxBytesReader(w, r.Body, h.cfg.Upload.MaxFileSize+1024*1024) // extra 1MB for text fields
	if err := r.ParseMultipartForm(h.cfg.Upload.MaxFileSize); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "request too large"))
		return
	}

	content := strings.TrimSpace(r.FormValue("content"))

	// Get files
	files := r.MultipartForm.File["files"]
	if len(files) == 0 && content == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "message must have content or attachments"))
		return
	}
	if len(files) > 10 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "maximum 10 attachments per message"))
		return
	}

	// Enforce the same permissions as a normal message send, plus AttachFiles for
	// actual attachments, so this route cannot be used to bypass a channel mute.
	if !requireChannelPermission(h.db, w, r, channelID, userID, permissions.SendMessages) {
		return
	}
	if len(files) > 0 && !requireChannelPermission(h.db, w, r, channelID, userID, permissions.AttachFiles) {
		return
	}
	if content == "" {
		content = " " // empty content placeholder when only files
	}
	if len(content) > 4000 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "message content cannot exceed 4000 characters"))
		return
	}

	// Persist the files FIRST, outside any transaction: the channel's
	// message-insert lock must never be held across file I/O (a slow upload
	// would block every message send to the channel), and the DB rows
	// (message + attachments) still commit atomically in the short locked
	// transaction below. A failure after some files are stored leaves orphan
	// FILES only, never orphan rows.
	type savedFile struct {
		filename    string
		storedName  string
		contentType string
		size        int64
		url         string
	}
	saved := make([]savedFile, 0, len(files))
	for _, fh := range files {
		if fh.Size > h.cfg.Upload.MaxFileSize {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "file too large"))
			return
		}

		file, err := fh.Open()
		if err != nil {
			log.Error().Err(err).Msg("failed to open uploaded file")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}

		detected, err := sniffContentType(file)
		if err != nil {
			_ = file.Close()
			log.Error().Err(err).Msg("failed to inspect uploaded file")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		storedName, url, err := h.storage.Save(file, safeExtensionForType(detected))
		_ = file.Close()
		if err != nil {
			log.Error().Err(err).Msg("failed to save file")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		// Store the detected content type, never the spoofable client header.
		saved = append(saved, savedFile{
			filename: fh.Filename, storedName: storedName,
			contentType: detected, size: fh.Size, url: url,
		})
	}

	// Short locked transaction: message + attachment rows only.
	var msg models.Message
	var author models.Author
	attachments := make([]models.Attachment, 0, len(saved))
	err = insertMessageTx(r.Context(), h.db, channelID, func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(),
			`WITH new_msg AS (
				INSERT INTO messages (channel_id, author_id, content)
				VALUES ($1, $2, $3)
				RETURNING id, channel_id, author_id, content, edited_at, created_at, seq
			)
			SELECT m.id, m.channel_id, m.content, m.edited_at, m.created_at, m.seq,
				   u.id, u.username, u.display_name, u.avatar_url, u.is_bot
			FROM new_msg m
			INNER JOIN users u ON u.id = m.author_id`,
			channelID, userID, content,
		).Scan(&msg.ID, &msg.ChannelID, &msg.Content, &msg.EditedAt, &msg.CreatedAt, &msg.Seq,
			&author.ID, &author.Username, &author.DisplayName, &author.AvatarURL, &author.IsBot); err != nil {
			return err
		}
		for _, sf := range saved {
			var att models.Attachment
			if err := tx.QueryRow(r.Context(),
				`INSERT INTO attachments (message_id, filename, stored_name, content_type, size, url)
				 VALUES ($1, $2, $3, $4, $5, $6)
				 RETURNING id, message_id, filename, stored_name, content_type, size, url, created_at`,
				msg.ID, sf.filename, sf.storedName, sf.contentType, sf.size, sf.url,
			).Scan(&att.ID, &att.MessageID, &att.Filename, &att.StoredName,
				&att.ContentType, &att.Size, &att.URL, &att.CreatedAt); err != nil {
				return err
			}
			attachments = append(attachments, att)
		}
		return nil
	})
	if err != nil {
		log.Error().Err(err).Msg("failed to insert upload message")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	msg.Author = &author

	msg.Attachments = attachments

	// Broadcast
	h.hub.BroadcastToChannel(channelID, realtime.Event{
		Type: realtime.EventMessageCreate,
		Data: map[string]any{"message": msg, "eventAt": time.Now().UTC()},
	})

	writeJSON(w, http.StatusCreated, msg)
}
