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

// GifEnabled returns true if any GIF provider is configured.
func (h *GifHandler) GifEnabled() bool {
	return h.cfg.TenorAPIKey != "" || h.cfg.GiphyAPIKey != ""
}

// GifProvider returns which provider is active: "tenor", "giphy", or "".
func (h *GifHandler) GifProvider() string {
	if h.cfg.TenorAPIKey != "" {
		return "tenor"
	}
	if h.cfg.GiphyAPIKey != "" {
		return "giphy"
	}
	return ""
}

type gifResult struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	PreviewURL string `json:"previewUrl"`
	URL        string `json:"url"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
}

// ---- Tenor types ----

type tenorResponse struct {
	Results []tenorResult `json:"results"`
}

type tenorResult struct {
	ID           string                      `json:"id"`
	Title        string                      `json:"title"`
	MediaFormats map[string]tenorMediaFormat `json:"media_formats"`
}

type tenorMediaFormat struct {
	URL  string `json:"url"`
	Dims []int  `json:"dims"`
}

// ---- Giphy types ----

type giphyResponse struct {
	Data []giphyGif `json:"data"`
}

type giphyGif struct {
	ID     string      `json:"id"`
	Title  string      `json:"title"`
	Images giphyImages `json:"images"`
}

type giphyImages struct {
	Original         giphyImage `json:"original"`
	FixedHeightSmall giphyImage `json:"fixed_height_small"`
}

type giphyImage struct {
	URL    string `json:"url"`
	Width  string `json:"width"`
	Height string `json:"height"`
}

// ---- Handlers ----

func (h *GifHandler) Search(w http.ResponseWriter, r *http.Request) {
	if !h.GifEnabled() {
		writeJSON(w, http.StatusServiceUnavailable, errorResponse("INTERNAL_ERROR", "GIF search is not configured"))
		return
	}

	query := r.URL.Query().Get("q")
	if query == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse("VALIDATION_ERROR", "query parameter 'q' is required"))
		return
	}

	limit := 20
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 && parsed <= 50 {
			limit = parsed
		}
	}

	if h.cfg.TenorAPIKey != "" {
		h.searchTenor(w, r, query, limit)
	} else {
		h.searchGiphy(w, r, query, limit)
	}
}

func (h *GifHandler) Trending(w http.ResponseWriter, r *http.Request) {
	if !h.GifEnabled() {
		writeJSON(w, http.StatusServiceUnavailable, errorResponse("INTERNAL_ERROR", "GIF search is not configured"))
		return
	}

	limit := 20
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 && parsed <= 50 {
			limit = parsed
		}
	}

	if h.cfg.TenorAPIKey != "" {
		h.trendingTenor(w, r, limit)
	} else {
		h.trendingGiphy(w, r, limit)
	}
}

// ---- Tenor implementation ----

func (h *GifHandler) searchTenor(w http.ResponseWriter, r *http.Request, query string, limit int) {
	req, err := http.NewRequestWithContext(r.Context(), "GET", "https://tenor.googleapis.com/v2/search", nil)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
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
		writeJSON(w, http.StatusBadGateway, errorResponse("INTERNAL_ERROR", "failed to reach GIF service"))
		return
	}
	defer resp.Body.Close()

	var tenorResp tenorResponse
	if err := json.NewDecoder(resp.Body).Decode(&tenorResp); err != nil {
		writeJSON(w, http.StatusBadGateway, errorResponse("INTERNAL_ERROR", "failed to parse GIF response"))
		return
	}

	writeJSON(w, http.StatusOK, parseTenorResults(tenorResp.Results))
}

func (h *GifHandler) trendingTenor(w http.ResponseWriter, r *http.Request, limit int) {
	req, err := http.NewRequestWithContext(r.Context(), "GET", "https://tenor.googleapis.com/v2/featured", nil)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
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
		writeJSON(w, http.StatusBadGateway, errorResponse("INTERNAL_ERROR", "failed to reach GIF service"))
		return
	}
	defer resp.Body.Close()

	var tenorResp tenorResponse
	if err := json.NewDecoder(resp.Body).Decode(&tenorResp); err != nil {
		writeJSON(w, http.StatusBadGateway, errorResponse("INTERNAL_ERROR", "failed to parse GIF response"))
		return
	}

	writeJSON(w, http.StatusOK, parseTenorResults(tenorResp.Results))
}

func parseTenorResults(results []tenorResult) []gifResult {
	gifs := make([]gifResult, 0, len(results))
	for _, r := range results {
		gif := gifResult{
			ID:    r.ID,
			Title: r.Title,
		}
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

// ---- Giphy implementation ----

func (h *GifHandler) searchGiphy(w http.ResponseWriter, r *http.Request, query string, limit int) {
	req, err := http.NewRequestWithContext(r.Context(), "GET", "https://api.giphy.com/v1/gifs/search", nil)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	q := req.URL.Query()
	q.Set("api_key", h.cfg.GiphyAPIKey)
	q.Set("q", query)
	q.Set("limit", strconv.Itoa(limit))
	q.Set("rating", "pg-13")
	req.URL.RawQuery = q.Encode()

	resp, err := h.client.Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, errorResponse("INTERNAL_ERROR", "failed to reach GIF service"))
		return
	}
	defer resp.Body.Close()

	var giphyResp giphyResponse
	if err := json.NewDecoder(resp.Body).Decode(&giphyResp); err != nil {
		writeJSON(w, http.StatusBadGateway, errorResponse("INTERNAL_ERROR", "failed to parse GIF response"))
		return
	}

	writeJSON(w, http.StatusOK, parseGiphyResults(giphyResp.Data))
}

func (h *GifHandler) trendingGiphy(w http.ResponseWriter, r *http.Request, limit int) {
	req, err := http.NewRequestWithContext(r.Context(), "GET", "https://api.giphy.com/v1/gifs/trending", nil)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse("INTERNAL_ERROR", "internal server error"))
		return
	}
	q := req.URL.Query()
	q.Set("api_key", h.cfg.GiphyAPIKey)
	q.Set("limit", strconv.Itoa(limit))
	q.Set("rating", "pg-13")
	req.URL.RawQuery = q.Encode()

	resp, err := h.client.Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, errorResponse("INTERNAL_ERROR", "failed to reach GIF service"))
		return
	}
	defer resp.Body.Close()

	var giphyResp giphyResponse
	if err := json.NewDecoder(resp.Body).Decode(&giphyResp); err != nil {
		writeJSON(w, http.StatusBadGateway, errorResponse("INTERNAL_ERROR", "failed to parse GIF response"))
		return
	}

	writeJSON(w, http.StatusOK, parseGiphyResults(giphyResp.Data))
}

func parseGiphyResults(data []giphyGif) []gifResult {
	gifs := make([]gifResult, 0, len(data))
	for _, g := range data {
		gif := gifResult{
			ID:         g.ID,
			Title:      g.Title,
			PreviewURL: g.Images.FixedHeightSmall.URL,
			URL:        g.Images.Original.URL,
		}
		if w, err := strconv.Atoi(g.Images.Original.Width); err == nil {
			gif.Width = w
		}
		if h, err := strconv.Atoi(g.Images.Original.Height); err == nil {
			gif.Height = h
		}
		if gif.URL != "" {
			gifs = append(gifs, gif)
		}
	}
	return gifs
}
