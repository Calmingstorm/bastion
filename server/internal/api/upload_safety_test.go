package api_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

// pngPixel is a valid 1x1 PNG (http.DetectContentType matches it as image/png).
var pngPixel = []byte{
	0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a,
	0x00, 0x00, 0x00, 0x0d, 'I', 'H', 'D', 'R',
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
	0x00, 0x00, 0x00, 0x0a, 'I', 'D', 'A', 'T',
	0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01,
	0x0d, 0x0a, 0x2d, 0xdb, 0x00, 0x00, 0x00, 0x00, 'I', 'E', 'N', 'D',
	0xae, 0x42, 0x60, 0x82,
}

var evilHTML = []byte(`<!DOCTYPE html><html><body><script>document.title='xss'</script></body></html>`)

// uploadFile posts a single file part (with a caller-controlled Content-Type,
// so we can simulate a spoofed header) plus optional form fields.
func uploadFile(t *testing.T, h *testutil.Harness, path, token, field, filename, contentType string, data []byte, fields map[string]string) *http.Response {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	for k, v := range fields {
		if err := mw.WriteField(k, v); err != nil {
			t.Fatalf("write field: %v", err)
		}
	}
	mh := make(textproto.MIMEHeader)
	mh.Set("Content-Disposition", fmt.Sprintf(`form-data; name=%q; filename=%q`, field, filename))
	mh.Set("Content-Type", contentType)
	part, err := mw.CreatePart(mh)
	if err != nil {
		t.Fatalf("create part: %v", err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatalf("write part: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}

	req, err := http.NewRequest(http.MethodPost, h.URL(path), &body)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	return resp
}

// TestAvatarRejectsDisguisedHTML: an HTML payload with a spoofed image/png header
// and .png name must be rejected, because validation inspects the actual bytes.
func TestAvatarRejectsDisguisedHTML(t *testing.T) {
	h := testutil.New(t)
	user := h.Register("alice")

	resp := uploadFile(t, h, "/api/v1/users/me/avatar", user.AccessToken, "avatar", "evil.png", "image/png", evilHTML, nil)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("disguised HTML avatar: expected 400, got %d", resp.StatusCode)
	}
}

// TestAvatarAcceptsRealImage: a genuine PNG is accepted.
func TestAvatarAcceptsRealImage(t *testing.T) {
	h := testutil.New(t)
	user := h.Register("bob")

	resp := uploadFile(t, h, "/api/v1/users/me/avatar", user.AccessToken, "avatar", "me.png", "image/png", pngPixel, nil)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("valid PNG avatar: expected 200, got %d", resp.StatusCode)
	}
}

// uploadAttachmentURL uploads a message attachment and returns its served URL.
func uploadAttachmentURL(t *testing.T, h *testutil.Harness, user *testutil.TestUser, channelID, filename, contentType string, data []byte) string {
	t.Helper()
	resp := uploadFile(t, h, "/api/v1/channels/"+channelID+"/messages/upload", user.AccessToken, "files", filename, contentType, data, map[string]string{"content": "see attachment"})
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("upload attachment: expected 201, got %d: %s", resp.StatusCode, string(b))
	}
	var out struct {
		Attachments []struct {
			URL string `json:"url"`
		} `json:"attachments"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode upload response: %v", err)
	}
	if len(out.Attachments) != 1 {
		t.Fatalf("expected 1 attachment, got %d", len(out.Attachments))
	}
	return out.Attachments[0].URL
}

// TestServedAttachmentIsNotExecutableHTML: an uploaded .html attachment must be
// served as a non-renderable download, never as text/html on our origin.
func TestServedAttachmentIsNotExecutableHTML(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")

	url := uploadAttachmentURL(t, h, owner, channelID, "evil.html", "text/html", evilHTML)

	resp, err := http.Get(h.URL(url))
	if err != nil {
		t.Fatalf("GET attachment: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if got := resp.Header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
	}
	if got := resp.Header.Get("Content-Disposition"); got != "attachment" {
		t.Errorf("Content-Disposition = %q, want attachment", got)
	}
	if ct := resp.Header.Get("Content-Type"); ct == "text/html" || ct == "text/html; charset=utf-8" {
		t.Errorf("Content-Type = %q; must not be text/html", ct)
	}
}

// TestServeUploadRejectsPathTraversal: a request that escapes the upload root
// (literal or encoded "..") must not read files outside it.
func TestServeUploadRejectsPathTraversal(t *testing.T) {
	h := testutil.New(t)

	// Plant a secret just outside the upload root.
	secretName := "traversal-secret.txt"
	secretPath := filepath.Join(filepath.Dir(h.Cfg.Upload.Dir), secretName)
	if err := os.WriteFile(secretPath, []byte("TOP-SECRET-DO-NOT-LEAK"), 0o600); err != nil {
		t.Fatalf("write secret: %v", err)
	}
	defer func() { _ = os.Remove(secretPath) }()

	for _, p := range []string{
		"/api/v1/uploads/../" + secretName,
		"/api/v1/uploads/%2e%2e/" + secretName,
		"/api/v1/uploads/..%2f" + secretName,
		"/api/v1/uploads/....//" + secretName,
	} {
		resp, err := http.Get(h.URL(p))
		if err != nil {
			t.Fatalf("GET %s: %v", p, err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if strings.Contains(string(body), "TOP-SECRET") {
			t.Fatalf("path traversal leaked the secret via %s (status %d)", p, resp.StatusCode)
		}
	}
}

// TestServedImageAttachmentIsInline: a genuine image is served inline as its type.
func TestServedImageAttachmentIsInline(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")

	url := uploadAttachmentURL(t, h, owner, channelID, "pic.png", "image/png", pngPixel)

	resp, err := http.Get(h.URL(url))
	if err != nil {
		t.Fatalf("GET attachment: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if got := resp.Header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
	}
	if got := resp.Header.Get("Content-Disposition"); got != "inline" {
		t.Errorf("Content-Disposition = %q, want inline", got)
	}
	if got := resp.Header.Get("Content-Type"); got != "image/png" {
		t.Errorf("Content-Type = %q, want image/png", got)
	}
}
