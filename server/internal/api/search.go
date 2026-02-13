package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
)

type SearchHandler struct {
	db *pgxpool.Pool
}

func NewSearchHandler(db *pgxpool.Pool) *SearchHandler {
	return &SearchHandler{db: db}
}

type searchResult struct {
	ID          uuid.UUID `json:"id"`
	ChannelID   uuid.UUID `json:"channelId"`
	Content     string    `json:"content"`
	CreatedAt   string    `json:"createdAt"`
	AuthorID    uuid.UUID `json:"authorId"`
	Username    string    `json:"username"`
	DisplayName *string   `json:"displayName"`
	AvatarURL   *string   `json:"avatarUrl"`
	IsBot       bool      `json:"isBot,omitempty"`
	ChannelName string    `json:"channelName"`
	ServerName  *string   `json:"serverName"`
}

func (h *SearchHandler) Search(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())

	query := r.URL.Query().Get("q")
	if query == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "query parameter 'q' is required"))
		return
	}

	limit := 25
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 && parsed <= 50 {
			limit = parsed
		}
	}
	offset := 0
	if o := r.URL.Query().Get("offset"); o != "" {
		if parsed, err := strconv.Atoi(o); err == nil && parsed >= 0 {
			offset = parsed
		}
	}

	// Optional scope filters
	serverIDParam := r.URL.Query().Get("serverId")
	channelIDParam := r.URL.Query().Get("channelId")

	var rows_err error

	// Build query based on filters
	baseSQL := `SELECT m.id, m.channel_id, m.content, m.created_at,
		u.id, u.username, u.display_name, u.avatar_url, u.is_bot,
		c.name, s.name
		FROM messages m
		INNER JOIN users u ON u.id = m.author_id
		INNER JOIN channels c ON c.id = m.channel_id
		LEFT JOIN servers s ON s.id = c.server_id
		WHERE m.search_vector @@ plainto_tsquery('english', $1)`

	// Access control: user must be member of server or DM
	accessSQL := ` AND (
		EXISTS(SELECT 1 FROM server_members sm INNER JOIN channels ch ON ch.server_id = sm.server_id WHERE ch.id = m.channel_id AND sm.user_id = $2)
		OR EXISTS(SELECT 1 FROM dm_members dm WHERE dm.channel_id = m.channel_id AND dm.user_id = $2)
	)`

	orderSQL := ` ORDER BY m.created_at DESC LIMIT $3 OFFSET $4`

	var results []searchResult

	if channelIDParam != "" {
		channelID, err := uuid.Parse(channelIDParam)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid channelId"))
			return
		}
		fullSQL := baseSQL + ` AND m.channel_id = $5` + accessSQL + orderSQL
		rows, err := h.db.Query(r.Context(), fullSQL, query, userID, limit, offset, channelID)
		if err != nil {
			rows_err = err
		} else {
			defer rows.Close()
			results, rows_err = scanSearchResults(rows)
		}
	} else if serverIDParam != "" {
		serverID, err := uuid.Parse(serverIDParam)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid serverId"))
			return
		}
		fullSQL := baseSQL + ` AND c.server_id = $5` + accessSQL + orderSQL
		rows, err := h.db.Query(r.Context(), fullSQL, query, userID, limit, offset, serverID)
		if err != nil {
			rows_err = err
		} else {
			defer rows.Close()
			results, rows_err = scanSearchResults(rows)
		}
	} else {
		fullSQL := baseSQL + accessSQL + orderSQL
		rows, err := h.db.Query(r.Context(), fullSQL, query, userID, limit, offset)
		if err != nil {
			rows_err = err
		} else {
			defer rows.Close()
			results, rows_err = scanSearchResults(rows)
		}
	}

	if rows_err != nil {
		log.Error().Err(rows_err).Msg("failed to search messages")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeJSON(w, http.StatusOK, results)
}

func scanSearchResults(rows interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
}) ([]searchResult, error) {
	var results []searchResult
	for rows.Next() {
		var r searchResult
		var createdAt time.Time
		if err := rows.Scan(
			&r.ID, &r.ChannelID, &r.Content, &createdAt,
			&r.AuthorID, &r.Username, &r.DisplayName, &r.AvatarURL, &r.IsBot,
			&r.ChannelName, &r.ServerName,
		); err != nil {
			return nil, err
		}
		r.CreatedAt = createdAt.Format(time.RFC3339Nano)
		results = append(results, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if results == nil {
		results = []searchResult{}
	}
	return results, nil
}
