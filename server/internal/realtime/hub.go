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
	// userID -> set of clients (for direct user notifications)
	users map[uuid.UUID]map[*Client]struct{}
	mu    sync.RWMutex

	registerCh   chan subscription
	unregisterCh chan subscription
	broadcastCh  chan broadcastMessage
	stopCh       chan struct{}
}

func NewHub() *Hub {
	return &Hub{
		channels:     make(map[uuid.UUID]map[*Client]struct{}),
		users:        make(map[uuid.UUID]map[*Client]struct{}),
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

// SubscribeUser subscribes all connected clients of a user to a channel.
func (h *Hub) SubscribeUser(userID, channelID uuid.UUID) {
	h.mu.RLock()
	clients, ok := h.users[userID]
	if !ok {
		h.mu.RUnlock()
		return
	}
	// Collect clients under read lock
	clientList := make([]*Client, 0, len(clients))
	for c := range clients {
		clientList = append(clientList, c)
	}
	h.mu.RUnlock()

	// Subscribe each client (goes through the channel-based register flow)
	for _, c := range clientList {
		h.Subscribe(channelID, c)
	}
}

// UnsubscribeUser unsubscribes all connected clients of a user from a channel.
func (h *Hub) UnsubscribeUser(userID, channelID uuid.UUID) {
	h.mu.RLock()
	clients, ok := h.users[userID]
	if !ok {
		h.mu.RUnlock()
		return
	}
	clientList := make([]*Client, 0, len(clients))
	for c := range clients {
		clientList = append(clientList, c)
	}
	h.mu.RUnlock()

	for _, c := range clientList {
		h.Unsubscribe(channelID, c)
	}
}

// SubscribeUserSync subscribes all of a user's clients to a channel synchronously
// (directly under the hub lock, not via the async register queue), so the
// subscription is in effect the instant the call returns. Used by reconciliation
// on the mutation path where an ordering window would otherwise let an event slip
// through before the change applied.
func (h *Hub) SubscribeUserSync(userID, channelID uuid.UUID) {
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

// UnsubscribeUserSync unsubscribes all of a user's clients from a channel
// synchronously (directly under the hub lock), so no broadcast issued after this
// call returns can still reach the user on that channel.
func (h *Hub) UnsubscribeUserSync(userID, channelID uuid.UUID) {
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
