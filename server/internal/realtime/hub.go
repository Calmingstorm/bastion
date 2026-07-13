package realtime

import (
	"sync"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
)

type broadcastMessage struct {
	channelID uuid.UUID
	event     Event
}

type Hub struct {
	// channelID -> set of clients
	channels map[uuid.UUID]map[*Client]struct{}
	// userID -> set of clients (for direct user notifications)
	users map[uuid.UUID]map[*Client]struct{}
	mu    sync.RWMutex

	broadcastCh chan broadcastMessage
	stopCh      chan struct{}
}

func NewHub() *Hub {
	return &Hub{
		channels:    make(map[uuid.UUID]map[*Client]struct{}),
		users:       make(map[uuid.UUID]map[*Client]struct{}),
		broadcastCh: make(chan broadcastMessage, 256),
		stopCh:      make(chan struct{}),
	}
}

// Run drains the broadcast queue. Subscription changes are NOT queued: every
// subscribe/unsubscribe mutates the maps synchronously under the lock (see the
// methods below), so there is a single ordering model and a queued command can
// never be applied after a later synchronous change and resurrect stale access.
func (h *Hub) Run() {
	for {
		select {
		case msg := <-h.broadcastCh:
			h.mu.RLock()
			clients := h.channels[msg.channelID]
			for client := range clients {
				select {
				case client.send <- msg.event:
				default:
					dropped := client.dropCount.Add(1)
					log.Warn().
						Str("userID", client.userID.String()).
						Str("eventType", msg.event.Type).
						Int64("dropCount", dropped).
						Msg("dropping event, client send buffer full")
					if dropped >= 10 {
						client.closeSlow()
					}
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

// Subscribe adds a client to a channel synchronously, in effect the instant it
// returns.
func (h *Hub) Subscribe(channelID uuid.UUID, client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	set, ok := h.channels[channelID]
	if !ok {
		set = make(map[*Client]struct{})
		h.channels[channelID] = set
	}
	set[client] = struct{}{}
}

// Unsubscribe removes a client from a channel synchronously.
func (h *Hub) Unsubscribe(channelID uuid.UUID, client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if set, ok := h.channels[channelID]; ok {
		delete(set, client)
		if len(set) == 0 {
			delete(h.channels, channelID)
		}
	}
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
	// Also remove from user mapping
	if userClients, ok := h.users[client.userID]; ok {
		delete(userClients, client)
		if len(userClients) == 0 {
			delete(h.users, client.userID)
		}
	}
}

func (h *Hub) RegisterUser(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	clients, ok := h.users[client.userID]
	if !ok {
		clients = make(map[*Client]struct{})
		h.users[client.userID] = clients
	}
	clients[client] = struct{}{}
}

// RegisterAndSubscribe registers a newly connected client and subscribes it to
// the given channels in a single locked section. Doing both atomically means a
// concurrent revocation can only observe the client as fully connected or not at
// all — it can never slip between "registered" and "subscribed" and miss the
// client, which would otherwise let a stale subscription survive.
func (h *Hub) RegisterAndSubscribe(client *Client, channelIDs []uuid.UUID) {
	h.mu.Lock()
	defer h.mu.Unlock()
	users, ok := h.users[client.userID]
	if !ok {
		users = make(map[*Client]struct{})
		h.users[client.userID] = users
	}
	users[client] = struct{}{}
	for _, channelID := range channelIDs {
		set, ok := h.channels[channelID]
		if !ok {
			set = make(map[*Client]struct{})
			h.channels[channelID] = set
		}
		set[client] = struct{}{}
	}
}

// GetClientChannels returns all channel IDs a client is currently subscribed to.
func (h *Hub) GetClientChannels(client *Client) []uuid.UUID {
	h.mu.RLock()
	defer h.mu.RUnlock()
	var ids []uuid.UUID
	for chID, clients := range h.channels {
		if _, ok := clients[client]; ok {
			ids = append(ids, chID)
		}
	}
	return ids
}

// SubscribeUser subscribes all of a user's connected clients to a channel
// synchronously (under the hub lock), so the subscription is in effect the
// instant the call returns.
func (h *Hub) SubscribeUser(userID, channelID uuid.UUID) {
	h.mu.Lock()
	defer h.mu.Unlock()
	clients, ok := h.users[userID]
	if !ok {
		return
	}
	set, ok := h.channels[channelID]
	if !ok {
		set = make(map[*Client]struct{})
		h.channels[channelID] = set
	}
	for c := range clients {
		set[c] = struct{}{}
	}
}

// UnsubscribeUser unsubscribes all of a user's connected clients from a channel
// synchronously, so no broadcast issued after this returns can still reach the
// user on that channel.
func (h *Hub) UnsubscribeUser(userID, channelID uuid.UUID) {
	h.mu.Lock()
	defer h.mu.Unlock()
	clients, ok := h.users[userID]
	if !ok {
		return
	}
	set, ok := h.channels[channelID]
	if !ok {
		return
	}
	for c := range clients {
		delete(set, c)
	}
	if len(set) == 0 {
		delete(h.channels, channelID)
	}
}

func (h *Hub) BroadcastToUser(userID uuid.UUID, event Event) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	clients, ok := h.users[userID]
	if !ok || len(clients) == 0 {
		log.Debug().
			Str("userID", userID.String()).
			Str("eventType", event.Type).
			Msg("BroadcastToUser: no connected clients for user")
		return
	}
	for client := range clients {
		select {
		case client.send <- event:
		default:
			dropped := client.dropCount.Add(1)
			log.Warn().
				Str("userID", client.userID.String()).
				Str("eventType", event.Type).
				Int64("dropCount", dropped).
				Msg("dropping event, client send buffer full")
			if dropped >= 10 {
				client.closeSlow()
			}
		}
	}
}

// IsUserOnline returns true if the given user has at least one active WebSocket connection.
func (h *Hub) IsUserOnline(userID uuid.UUID) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	clients, ok := h.users[userID]
	return ok && len(clients) > 0
}
