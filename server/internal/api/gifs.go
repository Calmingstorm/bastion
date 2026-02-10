package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/Calmingstorm/bastion/server/internal/config"
)

type GifHandler struct {
	cfg    *config.Config
	client *http.Client
}

func NewGifHandler(cfg *config.Config) *GifHandler {
	return &GifHandler{
		cfg:    cfg,
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

type gifResult struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	PreviewURL string `json:"previewUrl"`
	URL        string `json:"url"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
}

type tenorResponse struct {
	Results []tenorResult `json:"results"`
}

type tenorResult struct {
	ID            string                       `json:"id"`
	Title         string                       `json:"title"`
	MediaFormats  map[string]tenorMediaFormat   `json:"media_formats"`
}

type tenorMediaFormat struct {
	URL  string    `json:"url"`
	Dims []int     `json:"dims"`
}

func (h *GifHandler) Search(w http.ResponseWriter, r *http.Request) {
	if h.cfg.TenorAPIKey == "" {
		writeJSON(w, http.StatusServiceUnavailable, errorBody("GIF search is not configured"))
		return
	}

	query := r.URL.Query().Get("q")
	if query == "" {
		writeJSON(w, http.StatusBadRequest, errorBody("query parameter 'q' is required"))
		return
	}

	limit := 20
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 && parsed <= 50 {
			limit = parsed
		}
	}

	req, err := http.NewRequestWithContext(r.Context(), "GET", "https://tenor.googleapis.com/v2/search", nil)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}
	q := req.URL.Query()
	q.Set("key", h.cfg.TenorAPIKey)
	q.Set("q", query)
	q.Set("limit", strconv.Itoa(limit))
	q.Set("contentfilter", "medium")
	q.Set("media_filter", "gif,tinygif")
	req.URL.RawQuery = q.Encode()

	resp, err := h.client.Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, errorBody("failed to reach GIF service"))
		return
	}
	defer resp.Body.Close()

	var tenorResp tenorResponse
	if err := json.NewDecoder(resp.Body).Decode(&tenorResp); err != nil {
		writeJSON(w, http.StatusBadGateway, errorBody("failed to parse GIF response"))
		return
	}

	results := parseTenorResults(tenorResp.Results)
	writeJSON(w, http.StatusOK, results)
}

func (h *GifHandler) Trending(w http.ResponseWriter, r *http.Request) {
	if h.cfg.TenorAPIKey == "" {
		writeJSON(w, http.StatusServiceUnavailable, errorBody("GIF search is not configured"))
		return
	}

	limit := 20
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 && parsed <= 50 {
			limit = parsed
		}
	}

	req, err := http.NewRequestWithContext(r.Context(), "GET", "https://tenor.googleapis.com/v2/featured", nil)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}
	q := req.URL.Query()
	q.Set("key", h.cfg.TenorAPIKey)
	q.Set("limit", strconv.Itoa(limit))
	q.Set("contentfilter", "medium")
	q.Set("media_filter", "gif,tinygif")
	req.URL.RawQuery = q.Encode()

	resp, err := h.client.Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, errorBody("failed to reach GIF service"))
		return
	}
	defer resp.Body.Close()

	var tenorResp tenorResponse
	if err := json.NewDecoder(resp.Body).Decode(&tenorResp); err != nil {
		writeJSON(w, http.StatusBadGateway, errorBody("failed to parse GIF response"))
		return
	}

	results := parseTenorResults(tenorResp.Results)
	writeJSON(w, http.StatusOK, results)
}

func parseTenorResults(results []tenorResult) []gifResult {
	gifs := make([]gifResult, 0, len(results))
	for _, r := range results {
		gif := gifResult{
			ID:    r.ID,
			Title: r.Title,
		}

		// Use tinygif for preview, gif for full
		if tg, ok := r.MediaFormats["tinygif"]; ok {
			gif.PreviewURL = tg.URL
		}
		if g, ok := r.MediaFormats["gif"]; ok {
			gif.URL = g.URL
			if len(g.Dims) >= 2 {
				gif.Width = g.Dims[0]
				gif.Height = g.Dims[1]
			}
		}

		if gif.URL != "" {
			gifs = append(gifs, gif)
		}
	}
	return gifs
}
