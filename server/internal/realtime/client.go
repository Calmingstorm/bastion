package realtime

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
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
}

func ServeWS(hub *Hub, w http.ResponseWriter, r *http.Request, userID uuid.UUID, db *pgxpool.Pool) {
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

	log.Info().
		Str("userID", userID.String()).
		Int("channels", len(channelIDs)).
		Msg("websocket client connected")

	ctx, cancel := context.WithCancel(r.Context())

	go client.writePump(ctx, cancel)
	go client.readPump(ctx, cancel)
}

func (c *Client) readPump(ctx context.Context, cancel context.CancelFunc) {
	defer func() {
		c.hub.UnsubscribeAll(c)
		c.conn.Close(websocket.StatusNormalClosure, "connection closed")
		cancel()
	}()

	for {
		_, _, err := c.conn.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) == websocket.StatusNormalClosure ||
				websocket.CloseStatus(err) == websocket.StatusGoingAway {
				log.Debug().Str("userID", c.userID.String()).Msg("websocket closed normally")
			} else {
				log.Debug().Err(err).Str("userID", c.userID.String()).Msg("websocket read error")
			}
			return
		}
		// For now we just consume messages (heartbeat pings are handled by the library).
		// Future: handle typing indicators, etc.
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
