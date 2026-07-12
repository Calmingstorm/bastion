package api

import (
	"io"
	"net/http"
	"strings"
)

// inlineRenderableTypes are the content types that may be served with an inline
// Content-Disposition. Everything else is served as a download so a browser
// never renders — and therefore never executes — an uploaded file on our origin
// (e.g. an HTML or SVG document disguised as an image).
var inlineRenderableTypes = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/gif":  true,
	"image/webp": true,
	"image/bmp":  true,
}

// extForType maps a detected content type to a canonical, safe stored extension.
var extForType = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/gif":  ".gif",
	"image/webp": ".webp",
	"image/bmp":  ".bmp",
}

// normalizeContentType lowercases a media type and strips any parameters
// (e.g. "text/html; charset=utf-8" -> "text/html").
func normalizeContentType(ct string) string {
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = ct[:i]
	}
	return strings.TrimSpace(strings.ToLower(ct))
}

// sniffContentType detects a stream's content type from its leading bytes,
// ignoring any client-supplied value, then rewinds the stream to the start so
// the caller can still read it in full.
func sniffContentType(rs io.ReadSeeker) (string, error) {
	buf := make([]byte, 512)
	n, err := io.ReadFull(rs, buf)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return "", err
	}
	if _, err := rs.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	return normalizeContentType(http.DetectContentType(buf[:n])), nil
}

// isInlineRenderable reports whether a content type is safe to serve inline.
func isInlineRenderable(ct string) bool {
	return inlineRenderableTypes[normalizeContentType(ct)]
}

// safeExtensionForType returns a canonical extension for known-safe types, and
// ".bin" otherwise, so a disguised executable extension is never stored on disk.
func safeExtensionForType(ct string) string {
	if ext, ok := extForType[normalizeContentType(ct)]; ok {
		return ext
	}
	return ".bin"
}
