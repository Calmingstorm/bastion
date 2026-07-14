package realtime

import (
	"errors"
	"sync"
	"sync/atomic"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
)

// ErrConnectUnstable is returned by ConnectClient when it cannot obtain a
// viewability snapshot that is not immediately invalidated by a concurrent
// revocation within its bounded attempts. The connection is failed closed rather
// than left holding a possibly-stale subscription set.
var ErrConnectUnstable = errors.New("realtime: connect could not converge on a stable viewability snapshot")

// connectMaxAttempts bounds ConnectClient's revalidation loop. Real connects
// converge in one or two iterations; only a pathological revocation flood could
// exhaust this, and that fails closed.
const connectMaxAttempts = 8

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

	// revGen increments on every revocation (UnsubscribeUser). A connecting
	// client samples it before reading its viewable channels and again after
	// subscribing; a change means a revocation raced the read, so the connect
	// path re-reads and reconciles rather than leave a stale subscription.
	revGen atomic.Uint64
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

// ReconcileGen returns the current revocation generation. A connect that samples
// it before reading viewability and sees the same value after subscribing knows
// no revocation raced it.
func (h *Hub) ReconcileGen() uint64 {
	return h.revGen.Load()
}

// ResubscribeClient adjusts a single client's channel membership from oldChannels
// to newChannels in one locked section (subscribe the additions, unsubscribe the
// removals). Used by the connect revalidation loop to converge on the current
// viewable set without a subscribe/unsubscribe flicker.
func (h *Hub) ResubscribeClient(client *Client, oldChannels, newChannels []uuid.UUID) {
	h.mu.Lock()
	defer h.mu.Unlock()
	newSet := make(map[uuid.UUID]struct{}, len(newChannels))
	for _, ch := range newChannels {
		newSet[ch] = struct{}{}
	}
	oldSet := make(map[uuid.UUID]struct{}, len(oldChannels))
	for _, ch := range oldChannels {
		oldSet[ch] = struct{}{}
	}
	for ch := range newSet {
		if _, had := oldSet[ch]; had {
			continue
		}
		set, ok := h.channels[ch]
		if !ok {
			set = make(map[*Client]struct{})
			h.channels[ch] = set
		}
		set[client] = struct{}{}
	}
	for ch := range oldSet {
		if _, keep := newSet[ch]; keep {
			continue
		}
		if set, ok := h.channels[ch]; ok {
			delete(set, client)
			if len(set) == 0 {
				delete(h.channels, ch)
			}
		}
	}
}

// ConnectClient registers a newly connected client and subscribes it to its
// viewable channels, revalidating if a revocation races the viewability read so a
// stale pre-revocation snapshot cannot install a persistent subscription. The
// client is registered first, so any revocation that commits after the final read
// reconciles it directly; any that commits during a read bumps the generation and
// forces a re-read. readViewable returns the caller's current viewable channels.
func (h *Hub) ConnectClient(client *Client, readViewable func() ([]uuid.UUID, error)) ([]uuid.UUID, error) {
	h.RegisterUser(client)
	var applied []uuid.UUID
	for i := 0; i < connectMaxAttempts; i++ {
		gen := h.ReconcileGen()
		viewable, err := readViewable()
		if err != nil {
			// A read failure must not leave the client registered (and, on a later
			// attempt, subscribed) with nothing to clean it up — ServeWS returns
			// before the pumps start, so it never calls UnsubscribeAll.
			h.UnsubscribeAll(client)
			return nil, err
		}
		h.ResubscribeClient(client, applied, viewable)
		applied = viewable
		if h.ReconcileGen() == gen {
			// Stable: no revocation raced this read, so the snapshot is current.
			return applied, nil
		}
	}
	// Exhausted the bound without ever observing a stable generation. The last
	// snapshot may be stale and nothing will reconcile it later, so fail closed
	// rather than install it.
	h.UnsubscribeAll(client)
	return nil, ErrConnectUnstable
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

// RemoveChannel drops a channel's entire subscriber set: a deleted channel's
// subscriptions must not outlive the row (they would pin client pointers until
// those clients disconnect, and ids are never reused).
func (h *Hub) RemoveChannel(channelID uuid.UUID) {
	// Bump the reconcile generation BEFORE mutating (the same ordering
	// UnsubscribeUser documents as load-bearing): a client CONNECTING
	// concurrently read its viewable snapshot while this channel still existed;
	// bumping first guarantees its stability check sees the change and re-reads,
	// instead of installing the dead subscription set forever if this goroutine
	// were preempted between the mutation and a later bump.
	h.revGen.Add(1)
	h.mu.Lock()
	delete(h.channels, channelID)
	h.mu.Unlock()
}

// unsubscribeUserFromChannel removes a user's clients from a channel WITHOUT
// bumping the reconcile generation -- used to roll back a speculative subscribe,
// which is not a revocation and must not disturb other in-flight revalidations.
func (h *Hub) unsubscribeUserFromChannel(userID, channelID uuid.UUID) {
	h.mu.Lock()
	defer h.mu.Unlock()
	set, ok := h.channels[channelID]
	if !ok {
		return
	}
	if clients, ok := h.users[userID]; ok {
		for c := range clients {
			delete(set, c)
		}
	}
	if len(set) == 0 {
		delete(h.channels, channelID)
	}
}

// SubscribeAuthorizedStable installs a freshly-created channel's subscriptions
// against a MOVING world. Revocations (UnsubscribeUser) and the channel's own
// deletion (RemoveChannel) both bump the reconcile generation, so this samples
// the generation, reads the authorized set, subscribes, and re-checks: if the
// generation moved, a revocation or a delete raced the read, so it rolls back
// its additions and retries. It returns the CONFIRMED recipient set only after a
// stable pass; (nil, false, nil) if the channel no longer exists (caller must
// broadcast nothing); or ErrConnectUnstable if it cannot converge. The
// convergent path is self-healing (the successful pass re-subscribes). The rare
// rollback CAN strip a subscription a concurrent connect/join legitimately
// installed for this already-committed channel, so the ABORT paths must bump the
// reconcile generation (the caller does, via RemoveChannel) to force those
// clients to re-read and reinstall.
func (h *Hub) SubscribeAuthorizedStable(channelID uuid.UUID, read func() (ids []uuid.UUID, exists bool, err error)) ([]uuid.UUID, bool, error) {
	for i := 0; i < connectMaxAttempts; i++ {
		gen := h.ReconcileGen()
		ids, exists, err := read()
		if err != nil {
			return nil, false, err
		}
		if !exists {
			return nil, false, nil
		}
		for _, uid := range ids {
			h.SubscribeUser(uid, channelID)
		}
		if h.ReconcileGen() == gen {
			return ids, true, nil // stable: no revocation or delete raced
		}
		for _, uid := range ids {
			h.unsubscribeUserFromChannel(uid, channelID)
		}
	}
	return nil, false, ErrConnectUnstable
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
	// Signal a revocation to any in-flight connect revalidation, even if the user
	// has no clients or no subscription right now — a client may be mid-connect
	// with a snapshot that predates this call.
	h.revGen.Add(1)

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
