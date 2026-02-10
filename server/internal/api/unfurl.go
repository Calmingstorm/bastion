package api

import (
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/Calmingstorm/bastion/server/internal/config"
)

type UnfurlHandler struct {
	cfg    *config.Config
	client *http.Client
	cache  *unfurlCache
}

type unfurlResult struct {
	MediaURL string `json:"mediaUrl"`
	Width    int    `json:"width,omitempty"`
	Height   int    `json:"height,omitempty"`
}

type cacheEntry struct {
	result    unfurlResult
	expiresAt time.Time
}

type unfurlCache struct {
	mu      sync.RWMutex
	entries map[string]cacheEntry
}

func newUnfurlCache() *unfurlCache {
	return &unfurlCache{entries: make(map[string]cacheEntry)}
}

func (c *unfurlCache) get(key string) (unfurlResult, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	entry, ok := c.entries[key]
	if !ok || time.Now().After(entry.expiresAt) {
		return unfurlResult{}, false
	}
	return entry.result, true
}

func (c *unfurlCache) set(key string, result unfurlResult) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = cacheEntry{result: result, expiresAt: time.Now().Add(1 * time.Hour)}
}

func NewUnfurlHandler(cfg *config.Config) *UnfurlHandler {
	return &UnfurlHandler{
		cfg:    cfg,
		client: &http.Client{Timeout: 10 * time.Second},
		cache:  newUnfurlCache(),
	}
}

// Tenor share URL: https://tenor.com/view/slug-gif-12345 or https://tenor.com/view/slug-12345
var tenorShareRe = regexp.MustCompile(`^https?://(?:www\.)?tenor\.com/view/[a-zA-Z0-9_-]+-(\d+)$`)

// Giphy share URL: https://giphy.com/gifs/slug-ID or https://giphy.com/gifs/ID
var giphyShareRe = regexp.MustCompile(`^https?://(?:www\.)?giphy\.com/gifs/(.+)$`)

func (h *UnfurlHandler) Unfurl(w http.ResponseWriter, r *http.Request) {
	rawURL := r.URL.Query().Get("url")
	if rawURL == "" {
		writeJSON(w, http.StatusBadRequest, errorBody("url parameter is required"))
		return
	}

	// Validate it's a proper URL
	parsed, err := url.Parse(rawURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid URL"))
		return
	}

	// Check cache
	if cached, ok := h.cache.get(rawURL); ok {
		writeJSON(w, http.StatusOK, cached)
		return
	}

	// Try Tenor
	if matches := tenorShareRe.FindStringSubmatch(rawURL); matches != nil {
		h.unfurlTenor(w, r, rawURL, matches[1])
		return
	}

	// Try Giphy
	if matches := giphyShareRe.FindStringSubmatch(rawURL); matches != nil {
		h.unfurlGiphy(w, rawURL, matches[1])
		return
	}

	writeJSON(w, http.StatusBadRequest, errorBody("unsupported URL"))
}

func (h *UnfurlHandler) unfurlTenor(w http.ResponseWriter, r *http.Request, originalURL, postID string) {
	if h.cfg.TenorAPIKey == "" {
		writeJSON(w, http.StatusServiceUnavailable, errorBody("GIF resolution is not configured"))
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), "GET", "https://tenor.googleapis.com/v2/posts", nil)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorBody("internal server error"))
		return
	}
	q := req.URL.Query()
	q.Set("key", h.cfg.TenorAPIKey)
	q.Set("ids", postID)
	q.Set("media_filter", "gif")
	req.URL.RawQuery = q.Encode()

	resp, err := h.client.Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, errorBody("failed to reach GIF service"))
		return
	}
	defer resp.Body.Close()

	var tenorResp tenorResponse
	if err := json.NewDecoder(resp.Body).Decode(&tenorResp); err != nil || len(tenorResp.Results) == 0 {
		writeJSON(w, http.StatusNotFound, errorBody("GIF not found"))
		return
	}

	tr := tenorResp.Results[0]
	result := unfurlResult{}
	if g, ok := tr.MediaFormats["gif"]; ok {
		result.MediaURL = g.URL
		if len(g.Dims) >= 2 {
			result.Width = g.Dims[0]
			result.Height = g.Dims[1]
		}
	}

	if result.MediaURL == "" {
		writeJSON(w, http.StatusNotFound, errorBody("GIF media not found"))
		return
	}

	h.cache.set(originalURL, result)
	writeJSON(w, http.StatusOK, result)
}

func (h *UnfurlHandler) unfurlGiphy(w http.ResponseWriter, originalURL, pathSuffix string) {
	// Giphy ID is the last hyphen-separated segment, or the entire segment if no hyphens
	parts := strings.Split(pathSuffix, "-")
	giphyID := parts[len(parts)-1]
	if giphyID == "" {
		writeJSON(w, http.StatusBadRequest, errorBody("could not extract Giphy ID"))
		return
	}

	result := unfurlResult{
		MediaURL: "https://media.giphy.com/media/" + giphyID + "/giphy.gif",
	}

	h.cache.set(originalURL, result)
	writeJSON(w, http.StatusOK, result)
}
