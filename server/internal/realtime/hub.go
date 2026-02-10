package realtime

import (
	"sync"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
)

type subscription struct {
	channelID uuid.UUID
	client    *Client
}

type broadcastMessage struct {
	channelID uuid.UUID
	event     Event
}

type Hub struct {
	// channelID -> set of clients
	channels map[uuid.UUID]map[*Client]struct{}
	mu       sync.RWMutex

	registerCh   chan subscription
	unregisterCh chan subscription
	broadcastCh  chan broadcastMessage
	stopCh       chan struct{}
}

func NewHub() *Hub {
	return &Hub{
		channels:     make(map[uuid.UUID]map[*Client]struct{}),
		registerCh:   make(chan subscription, 256),
		unregisterCh: make(chan subscription, 256),
		broadcastCh:  make(chan broadcastMessage, 256),
		stopCh:       make(chan struct{}),
	}
}

func (h *Hub) Run() {
	for {
		select {
		case sub := <-h.registerCh:
			h.mu.Lock()
			clients, ok := h.channels[sub.channelID]
			if !ok {
				clients = make(map[*Client]struct{})
				h.channels[sub.channelID] = clients
			}
			clients[sub.client] = struct{}{}
			h.mu.Unlock()
			log.Debug().
				Str("channelID", sub.channelID.String()).
				Str("userID", sub.client.userID.String()).
				Msg("client subscribed to channel")

		case sub := <-h.unregisterCh:
			h.mu.Lock()
			if clients, ok := h.channels[sub.channelID]; ok {
				delete(clients, sub.client)
				if len(clients) == 0 {
					delete(h.channels, sub.channelID)
				}
			}
			h.mu.Unlock()

		case msg := <-h.broadcastCh:
			h.mu.RLock()
			clients := h.channels[msg.channelID]
			for client := range clients {
				select {
				case client.send <- msg.event:
				default:
					// Client send buffer full, skip
					log.Warn().
						Str("userID", client.userID.String()).
						Msg("dropping event, client send buffer full")
				}
			}
			h.mu.RUnlock()

		case <-h.stopCh:
			return
		}
	}
}

func (h *Hub) Stop() {
	close(h.stopCh)
}

func (h *Hub) Subscribe(channelID uuid.UUID, client *Client) {
	h.registerCh <- subscription{channelID: channelID, client: client}
}

func (h *Hub) Unsubscribe(channelID uuid.UUID, client *Client) {
	h.unregisterCh <- subscription{channelID: channelID, client: client}
}

func (h *Hub) BroadcastToChannel(channelID uuid.UUID, event Event) {
	h.broadcastCh <- broadcastMessage{channelID: channelID, event: event}
}

func (h *Hub) UnsubscribeAll(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for chID, clients := range h.channels {
		delete(clients, client)
		if len(clients) == 0 {
			delete(h.channels, chID)
		}
	}
}
