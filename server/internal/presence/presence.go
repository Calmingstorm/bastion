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
	// EXPIRE atomically refreshes the TTL and reports whether the key existed.
	// When it did not, set the default online status with SET NX so a status set
	// concurrently (between the EXPIRE and here) is not clobbered back to online.
	refreshed, err := s.rdb.Expire(ctx, key, presenceTTL).Result()
	if err != nil || refreshed {
		return
	}
	if AfterHeartbeatExpireForTest != nil {
		AfterHeartbeatExpireForTest()
	}
	s.rdb.SetNX(ctx, key, "online", presenceTTL)
}

// AfterHeartbeatExpireForTest, when non-nil, runs on the Heartbeat miss path
// between the EXPIRE and the SET NX, so tests can deterministically interleave a
// concurrent status write. Nil in production.
var AfterHeartbeatExpireForTest func()

// MGetForTest, when non-nil, replaces the MGET in GetPresenceBatch, so tests can
// force a non-string value into the decode path. Nil in production.
var MGetForTest func(ctx context.Context, keys []string) ([]interface{}, error)

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

	mget := func(ctx context.Context, keys []string) ([]interface{}, error) {
		return s.rdb.MGet(ctx, keys...).Result()
	}
	if MGetForTest != nil {
		mget = MGetForTest
	}
	vals, err := mget(ctx, keys)
	if err != nil {
		return nil
	}

	result := make(map[uuid.UUID]string, len(userIDs))
	for i, id := range userIDs {
		if s, ok := vals[i].(string); ok {
			result[id] = s
		} else {
			result[id] = "offline"
		}
	}
	return result
}
