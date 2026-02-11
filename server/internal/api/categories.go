package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/auth"
	"github.com/Calmingstorm/bastion/server/internal/models"
	"github.com/Calmingstorm/bastion/server/internal/permissions"
	"github.com/Calmingstorm/bastion/server/internal/realtime"
)

type CategoryHandler struct {
	db  *pgxpool.Pool
	hub *realtime.Hub
}

func NewCategoryHandler(db *pgxpool.Pool, hub *realtime.Hub) *CategoryHandler {
	return &CategoryHandler{db: db, hub: hub}
}

type createCategoryRequest struct {
	Name string `json:"name"`
}

func (h *CategoryHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageCategories); !ok {
		return
	}

	var req createCategoryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 100 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "category name must be 1-100 characters"))
		return
	}

	var maxPos int
	err = h.db.QueryRow(r.Context(),
		`SELECT COALESCE(MAX(position), -1) FROM channel_categories WHERE server_id = $1`, serverID,
	).Scan(&maxPos)
	if err != nil {
		log.Error().Err(err).Msg("failed to get max category position")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	var cat models.ChannelCategory
	err = h.db.QueryRow(r.Context(),
		`INSERT INTO channel_categories (server_id, name, position)
		 VALUES ($1, $2, $3)
		 RETURNING id, server_id, name, position, created_at`,
		serverID, req.Name, maxPos+1,
	).Scan(&cat.ID, &cat.ServerID, &cat.Name, &cat.Position, &cat.CreatedAt)
	if err != nil {
		log.Error().Err(err).Msg("failed to create category")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditCategoryCreate, "category", cat.ID, nil, nil)

	// Broadcast to all server channels
	channelIDs, _ := getServerChannelIDs(r.Context(), h.db, serverID)
	for _, chID := range channelIDs {
		h.hub.BroadcastToChannel(chID, realtime.Event{
			Type: realtime.EventCategoryCreate,
			Data: cat,
		})
	}

	writeJSON(w, http.StatusCreated, cat)
}

func (h *CategoryHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}

	if !requireMembership(h.db, w, r, serverID, userID) {
		return
	}

	rows, err := h.db.Query(r.Context(),
		`SELECT id, server_id, name, position, created_at
		 FROM channel_categories WHERE server_id = $1
		 ORDER BY position ASC`, serverID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to list categories")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	defer rows.Close()

	cats := make([]models.ChannelCategory, 0)
	for rows.Next() {
		var cat models.ChannelCategory
		if err := rows.Scan(&cat.ID, &cat.ServerID, &cat.Name, &cat.Position, &cat.CreatedAt); err != nil {
			log.Error().Err(err).Msg("failed to scan category")
			writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
			return
		}
		cats = append(cats, cat)
	}

	writeJSON(w, http.StatusOK, cats)
}

type updateCategoryRequest struct {
	Name     *string `json:"name,omitempty"`
	Position *int    `json:"position,omitempty"`
}

func (h *CategoryHandler) Update(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}
	catID, err := parseUUID(chi.URLParam(r, "categoryID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid category ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageCategories); !ok {
		return
	}

	var req updateCategoryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid request body"))
		return
	}

	sets := []string{}
	args := []any{}
	argIdx := 1

	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" || len(name) > 100 {
			writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "category name must be 1-100 characters"))
			return
		}
		sets = append(sets, "name = $"+itoa(argIdx))
		args = append(args, name)
		argIdx++
	}

	if req.Position != nil {
		sets = append(sets, "position = $"+itoa(argIdx))
		args = append(args, *req.Position)
		argIdx++
	}

	if len(sets) == 0 {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "no fields to update"))
		return
	}

	args = append(args, catID, serverID)
	query := "UPDATE channel_categories SET " + strings.Join(sets, ", ") +
		" WHERE id = $" + itoa(argIdx) + " AND server_id = $" + itoa(argIdx+1) +
		" RETURNING id, server_id, name, position, created_at"

	var cat models.ChannelCategory
	err = h.db.QueryRow(r.Context(), query, args...).Scan(
		&cat.ID, &cat.ServerID, &cat.Name, &cat.Position, &cat.CreatedAt)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errorResponse("NOT_FOUND", "category not found"))
		return
	}

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditCategoryUpdate, "category", cat.ID, nil, nil)

	// Broadcast to all server channels
	channelIDs, _ := getServerChannelIDs(r.Context(), h.db, serverID)
	for _, chID := range channelIDs {
		h.hub.BroadcastToChannel(chID, realtime.Event{
			Type: realtime.EventCategoryUpdate,
			Data: cat,
		})
	}

	writeJSON(w, http.StatusOK, cat)
}

func (h *CategoryHandler) Delete(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	serverID, err := parseUUID(chi.URLParam(r, "serverID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid server ID"))
		return
	}
	catID, err := parseUUID(chi.URLParam(r, "categoryID"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "invalid category ID"))
		return
	}

	if _, ok := requirePermission(h.db, w, r, serverID, userID, permissions.ManageCategories); !ok {
		return
	}

	// Unset category_id on channels in this category
	_, err = h.db.Exec(r.Context(),
		`UPDATE channels SET category_id = NULL WHERE category_id = $1`, catID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to unset channel categories")
	}

	_, err = h.db.Exec(r.Context(),
		`DELETE FROM channel_categories WHERE id = $1 AND server_id = $2`, catID, serverID,
	)
	if err != nil {
		log.Error().Err(err).Msg("failed to delete category")
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}

	writeAuditLog(h.db, r.Context(), serverID, userID, models.AuditCategoryDelete, "category", catID, nil, nil)

	// Broadcast to all server channels
	channelIDs, _ := getServerChannelIDs(r.Context(), h.db, serverID)
	for _, chID := range channelIDs {
		h.hub.BroadcastToChannel(chID, realtime.Event{
			Type: realtime.EventCategoryDelete,
			Data: map[string]string{
				"categoryId": catID.String(),
				"serverId":   serverID.String(),
			},
		})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
