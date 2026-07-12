package api

import (
	"bytes"
	"io"
	"testing"
)

func TestNormalizeContentType(t *testing.T) {
	cases := map[string]string{
		"text/html; charset=utf-8": "text/html",
		"IMAGE/PNG":                "image/png",
		"  image/jpeg  ":           "image/jpeg",
		"application/octet-stream": "application/octet-stream",
	}
	for in, want := range cases {
		if got := normalizeContentType(in); got != want {
			t.Errorf("normalizeContentType(%q)=%q, want %q", in, got, want)
		}
	}
}

func TestIsInlineRenderable(t *testing.T) {
	inline := []string{"image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "IMAGE/PNG"}
	notInline := []string{"text/html", "image/svg+xml", "text/plain", "application/octet-stream", "application/pdf", "text/javascript"}
	for _, ct := range inline {
		if !isInlineRenderable(ct) {
			t.Errorf("isInlineRenderable(%q) = false, want true", ct)
		}
	}
	for _, ct := range notInline {
		if isInlineRenderable(ct) {
			t.Errorf("isInlineRenderable(%q) = true, want false", ct)
		}
	}
}

func TestSafeExtensionForType(t *testing.T) {
	cases := map[string]string{
		"image/png":                ".png",
		"image/jpeg":               ".jpg",
		"text/html":                ".bin",
		"image/svg+xml":            ".bin",
		"application/octet-stream": ".bin",
	}
	for ct, want := range cases {
		if got := safeExtensionForType(ct); got != want {
			t.Errorf("safeExtensionForType(%q)=%q, want %q", ct, got, want)
		}
	}
}

// pngPixel is a valid 1x1 PNG (enough for http.DetectContentType to match).
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

func TestSniffContentTypeDetectsAndRewinds(t *testing.T) {
	cases := []struct {
		name string
		data []byte
		want string
	}{
		{"png", pngPixel, "image/png"},
		{"html", []byte("<!DOCTYPE html><html><script>alert(1)</script></html>"), "text/html"},
		{"plain", []byte("just some text that is not html at all"), "text/plain"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rs := bytes.NewReader(tc.data)
			got, err := sniffContentType(rs)
			if err != nil {
				t.Fatalf("sniffContentType: %v", err)
			}
			if got != tc.want {
				t.Fatalf("detected %q, want %q", got, tc.want)
			}
			// Confirm the stream was rewound: a full read returns all bytes.
			rest, _ := io.ReadAll(rs)
			if len(rest) != len(tc.data) {
				t.Fatalf("stream not rewound: read %d bytes, want %d", len(rest), len(tc.data))
			}
		})
	}
}
