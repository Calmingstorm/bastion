package realtime

import (
	"context"
	"encoding/json"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"

	"github.com/Calmingstorm/bastion/server/internal/permissions"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingInterval   = 30 * time.Second
	maxMessageSize = 4096
	sendBufferSize = 256
)

type Client struct {
	hub    *Hub
	conn   *websocket.Conn
	userID uuid.UUID
	send   chan Event
	db     *pgxpool.Pool
	rdb    *redis.Client
	// dropCount counts consecutive dropped events. It is written from the hub's
	// broadcast goroutines (under a read lock, so concurrently) and reset from
	// this client's write pump, so it must be accessed atomically.
	dropCount atomic.Int64
	// closing guards closeSlow so that a flood of dropped events past the
	// threshold launches exactly one close worker, not one per drop.
	closing atomic.Bool
	// closeWorkers records how many close workers were launched (always 0 or 1).
	closeWorkers atomic.Int64
}

// closeSlow closes the connection off the caller's goroutine. A WebSocket close
// performs a handshake that can block for several seconds, which must never
// happen on the hub's broadcast path or while holding its lock. It is
// idempotent: only the first call launches a close worker, so repeated
// threshold breaches cannot spawn an unbounded number of goroutines.
func (c *Client) closeSlow() {
	if c.closing.Swap(true) {
		return
	}
	c.closeWorkers.Add(1)
	go func() {
		_ = c.conn.Close(websocket.StatusTryAgainLater, "too many dropped events")
	}()
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

	// Register the user and subscribe to their viewable channels, revalidating if
	// a permission revocation races the viewability read — otherwise a stale
	// pre-revocation snapshot could install a subscription that survives the
	// revocation's reconciliation indefinitely.
	channelIDs, err := hub.ConnectClient(client, func() ([]uuid.UUID, error) {
		return ViewableChannelIDs(r.Context(), db, userID)
	})
	if err != nil {
		// ConnectClient has already removed the client from the hub on failure.
		log.Error().Err(err).Str("userID", userID.String()).Msg("failed to establish channel subscriptions")
		conn.Close(websocket.StatusInternalError, "failed to load channels")
		return
	}

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

	// Use context.Background() — the WS connection outlives the HTTP handler.
	// r.Context() is canceled when ServeWS returns, which would kill the goroutines.
	ctx, cancel := context.WithCancel(context.Background())

	go client.writePump(ctx, cancel)
	go client.readPump(ctx, cancel)
}

func (c *Client) readPump(ctx context.Context, cancel context.CancelFunc) {
	defer func() {
		// Get current subscribed channels BEFORE unsubscribing (not the stale initial list)
		currentChannels := c.hub.GetClientChannels(c)
		c.hub.UnsubscribeAll(c)

		// Set presence to offline
		if c.rdb != nil {
			bgCtx := context.Background()
			c.rdb.Del(bgCtx, "presence:"+c.userID.String())
			// Broadcast offline to all channels we were subscribed to
			for _, chID := range currentChannels {
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
					// Broadcast to all currently subscribed channels
					for _, chID := range c.hub.GetClientChannels(c) {
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

				// The sender must currently be allowed to post here; otherwise a
				// member who lost access (or an outsider who knows the channel
				// UUID) could leak a typing indicator into a hidden channel.
				if !CanSendToChannel(ctx, c.db, c.userID, chID) {
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
			c.dropCount.Store(0)

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

// ViewableChannelIDs returns the IDs of every channel the user may view: server
// channels where they are the server owner or hold a role granting ViewChannel
// or Administrator, plus every DM channel they belong to. This is the canonical
// "what can this user see" query, used both to subscribe a WebSocket client and
// to scope search results. It enforces server-level permissions only — Bastion's
// per-channel override table is not yet wired.
func ViewableChannelIDs(ctx context.Context, db *pgxpool.Pool, userID uuid.UUID) ([]uuid.UUID, error) {
	viewBits := permissions.ViewChannel | permissions.Administrator
	query := `
		SELECT c.id
		FROM channels c
		INNER JOIN server_members sm ON sm.server_id = c.server_id AND sm.user_id = $1
		INNER JOIN servers s ON s.id = c.server_id
		WHERE s.owner_id = $1
		   OR (COALESCE((
		        SELECT bit_or(r.permissions)
		        FROM member_roles mr
		        INNER JOIN roles r ON r.id = mr.role_id
		        WHERE mr.server_id = c.server_id AND mr.user_id = $1
		      ), 0) & $2) != 0
		UNION
		SELECT dm.channel_id
		FROM dm_members dm
		WHERE dm.user_id = $1
	`

	rows, err := db.Query(ctx, query, userID, viewBits)
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

// CanSendToChannel reports whether the user may currently post in (and therefore
// type in) the channel: a DM participant, or a server member whose roles grant
// both ViewChannel and SendMessages. The server owner and any Administrator role
// always qualify. It fails closed on any lookup error so an unresolved channel or
// membership never opens the path.
func CanSendToChannel(ctx context.Context, db *pgxpool.Pool, userID, channelID uuid.UUID) bool {
	var serverID *uuid.UUID
	if err := db.QueryRow(ctx,
		`SELECT server_id FROM channels WHERE id = $1`, channelID,
	).Scan(&serverID); err != nil {
		return false
	}

	if serverID == nil {
		// DM channel: participation is the only gate.
		var ok bool
		if err := db.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM dm_members WHERE channel_id = $1 AND user_id = $2)`,
			channelID, userID,
		).Scan(&ok); err != nil {
			return false
		}
		return ok
	}

	var ownerID uuid.UUID
	if err := db.QueryRow(ctx,
		`SELECT owner_id FROM servers WHERE id = $1`, *serverID,
	).Scan(&ownerID); err != nil {
		return false
	}
	if ownerID == userID {
		return true
	}

	// Non-members hold no member_roles rows, so their bit_or is 0 and this denies.
	var bits int64
	if err := db.QueryRow(ctx,
		`SELECT COALESCE(bit_or(r.permissions), 0)
		 FROM member_roles mr
		 INNER JOIN roles r ON r.id = mr.role_id
		 WHERE mr.server_id = $1 AND mr.user_id = $2`,
		*serverID, userID,
	).Scan(&bits); err != nil {
		return false
	}
	if permissions.Has(bits, permissions.Administrator) {
		return true
	}
	return permissions.Has(bits, permissions.ViewChannel) && permissions.Has(bits, permissions.SendMessages)
}
