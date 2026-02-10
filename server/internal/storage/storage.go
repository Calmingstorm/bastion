package storage

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/config"
)

type FileStorage struct {
	baseDir string
	baseURL string
}

func NewFileStorage(cfg *config.UploadConfig) *FileStorage {
	if err := os.MkdirAll(cfg.Dir, 0755); err != nil {
		log.Fatal().Err(err).Str("dir", cfg.Dir).Msg("failed to create upload directory")
	}
	return &FileStorage{
		baseDir: cfg.Dir,
		baseURL: cfg.BaseURL,
	}
}

// Save stores a file and returns the stored name and URL.
func (fs *FileStorage) Save(reader io.Reader, ext string) (storedName string, url string, err error) {
	// Date-organized directory: uploads/2026/02/09/
	now := time.Now()
	dateDir := filepath.Join(fs.baseDir, now.Format("2006"), now.Format("01"), now.Format("02"))
	if err := os.MkdirAll(dateDir, 0755); err != nil {
		return "", "", fmt.Errorf("create date dir: %w", err)
	}

	storedName = uuid.New().String() + ext
	fullPath := filepath.Join(dateDir, storedName)

	file, err := os.Create(fullPath)
	if err != nil {
		return "", "", fmt.Errorf("create file: %w", err)
	}
	defer file.Close()

	if _, err := io.Copy(file, reader); err != nil {
		os.Remove(fullPath)
		return "", "", fmt.Errorf("write file: %w", err)
	}

	// URL uses relative date path
	relativePath := filepath.Join(now.Format("2006"), now.Format("01"), now.Format("02"), storedName)
	url = fs.baseURL + "/" + relativePath

	return storedName, url, nil
}

// Delete removes a stored file.
func (fs *FileStorage) Delete(relativePath string) error {
	fullPath := filepath.Join(fs.baseDir, relativePath)
	return os.Remove(fullPath)
}

// FullPath returns the absolute filesystem path for a relative stored path.
func (fs *FileStorage) FullPath(relativePath string) string {
	return filepath.Join(fs.baseDir, relativePath)
}
