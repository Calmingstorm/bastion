package api

import (
	"crypto/rand"
	"encoding/hex"
)

// generateWebhookToken creates a token with "whk_" prefix + 48 hex chars (192-bit entropy).
func generateWebhookToken() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "whk_" + hex.EncodeToString(b), nil
}

// generateBotToken creates a token with "bot_" prefix + 48 hex chars (192-bit entropy).
func generateBotToken() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "bot_" + hex.EncodeToString(b), nil
}
