package presence

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

const (
	presenceTTL = 90 * time.Second
	keyPrefix   = "presence:"
)

type Service struct {
	rdb *redis.Client
}

func NewService(rdb *redis.Client) *Service {
	return &Service{rdb: rdb}
}

func (s *Service) SetOnline(ctx context.Context, userID uuid.UUID) {
	key := keyPrefix + userID.String()
	if err := s.rdb.Set(ctx, key, "online", presenceTTL).Err(); err != nil {
		log.Error().Err(err).Str("userID", userID.String()).Msg("failed to set presence online")
	}
}

func (s *Service) SetStatus(ctx context.Context, userID uuid.UUID, status string) {
	key := keyPrefix + userID.String()
	if err := s.rdb.Set(ctx, key, status, presenceTTL).Err(); err != nil {
		log.Error().Err(err).Str("userID", userID.String()).Msg("failed to set presence status")
	}
}

func (s *Service) Heartbeat(ctx context.Context, userID uuid.UUID) {
	key := keyPrefix + userID.String()
	// Refresh TTL, set to online if not exists
	exists, _ := s.rdb.Exists(ctx, key).Result()
	if exists == 0 {
		s.rdb.Set(ctx, key, "online", presenceTTL)
	} else {
		s.rdb.Expire(ctx, key, presenceTTL)
	}
}

func (s *Service) SetOffline(ctx context.Context, userID uuid.UUID) {
	key := keyPrefix + userID.String()
	s.rdb.Del(ctx, key)
}

func (s *Service) GetPresence(ctx context.Context, userID uuid.UUID) string {
	key := keyPrefix + userID.String()
	val, err := s.rdb.Get(ctx, key).Result()
	if err != nil {
		return "offline"
	}
	return val
}

func (s *Service) GetPresenceBatch(ctx context.Context, userIDs []uuid.UUID) map[uuid.UUID]string {
	if len(userIDs) == 0 {
		return nil
	}

	keys := make([]string, len(userIDs))
	for i, id := range userIDs {
		keys[i] = keyPrefix + id.String()
	}

	vals, err := s.rdb.MGet(ctx, keys...).Result()
	if err != nil {
		return nil
	}

	result := make(map[uuid.UUID]string, len(userIDs))
	for i, id := range userIDs {
		if vals[i] != nil {
			result[id] = vals[i].(string)
		} else {
			result[id] = "offline"
		}
	}
	return result
}
