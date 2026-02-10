package realtime

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingInterval   = 30 * time.Second
	maxMessageSize = 4096
	sendBufferSize = 64
)

type Client struct {
	hub    *Hub
	conn   *websocket.Conn
	userID uuid.UUID
	send   chan Event
	db     *pgxpool.Pool
	rdb    *redis.Client
}

type incomingMessage struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

type typingData struct {
	ChannelID string `json:"channelId"`
}

func ServeWS(hub *Hub, w http.ResponseWriter, r *http.Request, userID uuid.UUID, db *pgxpool.Pool, rdb *redis.Client) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // Allow all origins for now (CORS handled separately)
	})
	if err != nil {
		log.Error().Err(err).Msg("websocket upgrade failed")
		return
	}

	conn.SetReadLimit(maxMessageSize)

	client := &Client{
		hub:    hub,
		conn:   conn,
		userID: userID,
		send:   make(chan Event, sendBufferSize),
		db:     db,
		rdb:    rdb,
	}

	// Subscribe to all channels the user has access to
	channelIDs, err := getUserChannelIDs(r.Context(), db, userID)
	if err != nil {
		log.Error().Err(err).Str("userID", userID.String()).Msg("failed to get user channels")
		conn.Close(websocket.StatusInternalError, "failed to load channels")
		return
	}

	for _, chID := range channelIDs {
		hub.Subscribe(chID, client)
	}

	// Register this client for user-targeted events
	hub.RegisterUser(client)

	log.Info().
		Str("userID", userID.String()).
		Int("channels", len(channelIDs)).
		Msg("websocket client connected")

	// Set presence to online
	if rdb != nil {
		rdb.Set(r.Context(), "presence:"+userID.String(), "online", 90*time.Second)
		// Broadcast presence to all subscribed channels
		for _, chID := range channelIDs {
			hub.BroadcastToChannel(chID, Event{
				Type: EventPresenceUpdate,
				Data: map[string]string{
					"userId": userID.String(),
					"status": "online",
				},
			})
		}
	}

	ctx, cancel := context.WithCancel(r.Context())

	go client.writePump(ctx, cancel)
	go client.readPump(ctx, cancel, channelIDs)
}

func (c *Client) readPump(ctx context.Context, cancel context.CancelFunc, channelIDs []uuid.UUID) {
	defer func() {
		c.hub.UnsubscribeAll(c)

		// Set presence to offline
		if c.rdb != nil {
			bgCtx := context.Background()
			c.rdb.Del(bgCtx, "presence:"+c.userID.String())
			// Broadcast offline to channels
			for _, chID := range channelIDs {
				c.hub.BroadcastToChannel(chID, Event{
					Type: EventPresenceUpdate,
					Data: map[string]string{
						"userId": c.userID.String(),
						"status": "offline",
					},
				})
			}
		}

		c.conn.Close(websocket.StatusNormalClosure, "connection closed")
		cancel()
	}()

	for {
		_, data, err := c.conn.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) == websocket.StatusNormalClosure ||
				websocket.CloseStatus(err) == websocket.StatusGoingAway {
				log.Debug().Str("userID", c.userID.String()).Msg("websocket closed normally")
			} else {
				log.Debug().Err(err).Str("userID", c.userID.String()).Msg("websocket read error")
			}
			return
		}

		// Parse incoming message
		var msg incomingMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "HEARTBEAT":
			// Refresh presence TTL
			if c.rdb != nil {
				c.rdb.Expire(ctx, "presence:"+c.userID.String(), 90*time.Second)
			}

		case "PRESENCE_UPDATE":
			// Client setting their own status
			var statusData struct {
				Status string `json:"status"`
			}
			if err := json.Unmarshal(msg.Data, &statusData); err == nil && statusData.Status != "" {
				if c.rdb != nil {
					c.rdb.Set(ctx, "presence:"+c.userID.String(), statusData.Status, 90*time.Second)
					// Broadcast to all channels
					for _, chID := range channelIDs {
						c.hub.BroadcastToChannel(chID, Event{
							Type: EventPresenceUpdate,
							Data: map[string]string{
								"userId": c.userID.String(),
								"status": statusData.Status,
							},
						})
					}
				}
			}

		case "TYPING_START":
			var td typingData
			if err := json.Unmarshal(msg.Data, &td); err == nil && td.ChannelID != "" {
				chID, err := uuid.Parse(td.ChannelID)
				if err != nil {
					continue
				}

				// Debounce with Redis: only broadcast if key doesn't exist
				if c.rdb != nil {
					key := "typing:" + td.ChannelID + ":" + c.userID.String()
					set, _ := c.rdb.SetNX(ctx, key, "1", 8*time.Second).Result()
					if !set {
						continue // already typing, skip broadcast
					}
				}

				c.hub.BroadcastToChannel(chID, Event{
					Type: EventTypingStart,
					Data: map[string]string{
						"channelId": td.ChannelID,
						"userId":    c.userID.String(),
					},
				})
			}
		}
	}
}

func (c *Client) writePump(ctx context.Context, cancel context.CancelFunc) {
	ticker := time.NewTicker(pingInterval)
	defer func() {
		ticker.Stop()
		cancel()
	}()

	for {
		select {
		case event, ok := <-c.send:
			if !ok {
				c.conn.Close(websocket.StatusNormalClosure, "")
				return
			}

			writeCtx, writeCancel := context.WithTimeout(ctx, writeWait)
			data, err := json.Marshal(event)
			if err != nil {
				writeCancel()
				log.Error().Err(err).Msg("failed to marshal event")
				continue
			}

			err = c.conn.Write(writeCtx, websocket.MessageText, data)
			writeCancel()
			if err != nil {
				log.Debug().Err(err).Str("userID", c.userID.String()).Msg("websocket write error")
				return
			}

		case <-ticker.C:
			pingCtx, pingCancel := context.WithTimeout(ctx, writeWait)
			err := c.conn.Ping(pingCtx)
			pingCancel()
			if err != nil {
				log.Debug().Err(err).Str("userID", c.userID.String()).Msg("websocket ping failed")
				return
			}

		case <-ctx.Done():
			return
		}
	}
}

func getUserChannelIDs(ctx context.Context, db *pgxpool.Pool, userID uuid.UUID) ([]uuid.UUID, error) {
	query := `
		SELECT c.id
		FROM channels c
		INNER JOIN server_members sm ON sm.server_id = c.server_id
		WHERE sm.user_id = $1
		UNION
		SELECT dm.channel_id
		FROM dm_members dm
		WHERE dm.user_id = $1
	`

	rows, err := db.Query(ctx, query, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}

	return ids, rows.Err()
}
