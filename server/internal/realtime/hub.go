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
			h.broadcastToClientsLocked(h.channels[msg.channelID], msg.event)
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

// BroadcastToChannelNow dispatches against the live subscription set before it
// returns. It is used while the caller holds the database's shared server-event
// fence, so an authorization/deletion transaction cannot commit between the
// final authoritative read and dispatch. Queueing for the hub loop would release
// that fence too early and recreate the post-commit delivery race.
func (h *Hub) BroadcastToChannelNow(channelID uuid.UUID, event Event) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	h.broadcastToClientsLocked(h.channels[channelID], event)
}

// broadcastToClientsLocked sends to a client set while h.mu is read-locked.
func (h *Hub) broadcastToClientsLocked(clients map[*Client]struct{}, event Event) {
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

// sameUUIDSet reports whether two id slices contain the same set of ids (order-
// insensitive). Used to detect that authorization membership is UNCHANGED across
// two reads even though the reconcile generation moved. Its inputs come from
// authorizedMemberIDs, which returns DISTINCT user ids (unique sm.user_id), so the
// len-plus-one-direction check is exact here; it is not a general multiset compare.
func sameUUIDSet(a, b []uuid.UUID) bool {
	if len(a) != len(b) {
		return false
	}
	set := make(map[uuid.UUID]struct{}, len(a))
	for _, id := range a {
		set[id] = struct{}{}
	}
	for _, id := range b {
		if _, ok := set[id]; !ok {
			return false
		}
	}
	return true
}

// SubscribeAuthorizedStable installs a freshly-created channel's subscriptions
// against a MOVING world. Revocations (UnsubscribeUser), the channel's own
// deletion (RemoveChannel), and grants (BumpReconcileGen) all move the reconcile
// generation. This reconciles the hub subscription to the authorized set,
// re-reading until it is CONSISTENT with a committed snapshot:
//
//   - FAST PATH: the generation held across [read..subscribe] -- nothing raced,
//     the hub matches the authorized set exactly (one read).
//   - SET-STABLE PATH: the generation moved, but two consecutive authorized reads
//     AGREE -- membership is stable, so the move was a grant/spurious bump or a
//     revoke+regrant that netted out, not a membership change we missed.
//   - EXHAUSTION: authorization never stabilized within connectMaxAttempts (a
//     genuine revocation flood -- in practice unreachable). We KEEP the last
//     reconciled subscription best-effort; the caller still delivers to the LIVE
//     hub set. (Under set-stable/exhaustion the hub can briefly lag the internal
//     bookkeeping in the SAFE direction -- offline/just-revoked ids stay in the
//     map but not the hub -- so delivery, which reads only the hub, cannot leak.)
//
// The caller ALWAYS delivers via BroadcastToChannel (the live subscription set
// under the hub lock), so a revocation landing after this returns is excluded by
// its own synchronous UnsubscribeUser, and a member whose revocation is committed
// but whose UnsubscribeUser is still pending is cleaned up by that revocation's
// reconcile (which reads the now-committed channel list) and reconciled on the
// client by CHANNELS_STALE -- never a persistent leak. Unlike the prior design it
// never rolls back live subscriptions on churn (that dropped live delivery) and
// never returns a non-convergence error (delivery is identical either way).
//
// It deliberately returns NO recipient set: delivery is the live hub set, never a
// captured slice, so a caller CANNOT reintroduce the leak by fanning out to a
// stale list. Returns (exists, err): exists=false (channel gone) -> caller
// broadcasts nothing; the speculative subscriptions are rolled back first.
func (h *Hub) SubscribeAuthorizedStable(channelID uuid.UUID, read func() (ids []uuid.UUID, exists bool, err error)) (bool, error) {
	var prev []uuid.UUID
	havePrev := false
	for i := 0; i < connectMaxAttempts; i++ {
		gen := h.ReconcileGen()
		ids, exists, err := read()
		if err != nil {
			// Do NOT tear down the channel's subscriptions on a transient read
			// error: the row is committed and any users a concurrent connect
			// subscribed are authorized (connects only subscribe viewable
			// channels), so dropping them would strand already-connected members
			// until they reconnect. Return the error; the caller broadcasts nothing
			// and the client self-heals on its next channel-list fetch. (Under the
			// create fence this is a pass-0 error with nothing yet subscribed by us;
			// the multi-pass fallback preserves the last authorized read's
			// subscriptions, reconciled on the next authorization change.)
			return false, err
		}
		if !exists {
			h.RemoveChannel(channelID) // channel is gone: drop its subscriptions
			return false, nil
		}
		// Reconcile the ENTIRE live set, not merely users added by this call. A
		// concurrent connect/join may already have subscribed a user whose access
		// was revoked before this read; leaving pre-existing entries untouched
		// would leak the create event and later messages.
		h.ReconcileChannelUsers(channelID, ids)
		if h.ReconcileGen() == gen {
			return true, nil
		}
		if havePrev && sameUUIDSet(prev, ids) {
			return true, nil
		}
		prev = ids
		havePrev = true
	}
	// The last exact reconciliation stands. The caller still dispatches against
	// the live set; authorization commits are fenced by the database.
	return true, nil
}

// ReconcileChannelUsers makes a channel's connected-client set exactly match
// the supplied authorized users in one locked section.
func (h *Hub) ReconcileChannelUsers(channelID uuid.UUID, authorized []uuid.UUID) {
	h.mu.Lock()
	defer h.mu.Unlock()
	want := make(map[uuid.UUID]struct{}, len(authorized))
	for _, uid := range authorized {
		want[uid] = struct{}{}
	}
	set := h.channels[channelID]
	if set == nil {
		set = make(map[*Client]struct{})
	}
	for client := range set {
		if _, ok := want[client.userID]; !ok {
			delete(set, client)
		}
	}
	for uid := range want {
		for client := range h.users[uid] {
			set[client] = struct{}{}
		}
	}
	if len(set) == 0 {
		delete(h.channels, channelID)
	} else {
		h.channels[channelID] = set
	}
}

// BumpReconcileGen advances the reconcile generation to signal an authorization
// change that does NOT unsubscribe anyone -- a GRANT. Revocations bump it via
// UnsubscribeUser; grants must bump it too, or a channel-create's stability loop
// (which re-reads authorization on a generation change) would miss a member who
// gained access mid-create and omit them from CHANNEL_CREATE while their socket
// still receives later messages.
func (h *Hub) BumpReconcileGen() {
	h.revGen.Add(1)
}

// SubscribeUser subscribes all of a user's connected clients to a channel
// synchronously (under the hub lock), so the subscription is in effect the
// instant the call returns.
func (h *Hub) SubscribeUser(userID, channelID uuid.UUID) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	clients, ok := h.users[userID]
	if !ok {
		return false
	}
	set, ok := h.channels[channelID]
	if !ok {
		set = make(map[*Client]struct{})
		h.channels[channelID] = set
	}
	added := false
	for c := range clients {
		if _, already := set[c]; !already {
			set[c] = struct{}{}
			added = true
		}
	}
	return added
}

// UnsubscribeUser unsubscribes all of a user's connected clients from a channel
// synchronously, so no broadcast issued after this returns can still reach the
// user on that channel.
func (h *Hub) UnsubscribeUser(userID, channelID uuid.UUID) bool {
	// Signal a revocation to any in-flight connect revalidation, even if the user
	// has no clients or no subscription right now — a client may be mid-connect
	// with a snapshot that predates this call.
	h.revGen.Add(1)

	h.mu.Lock()
	defer h.mu.Unlock()
	clients, ok := h.users[userID]
	if !ok {
		return false
	}
	set, ok := h.channels[channelID]
	if !ok {
		return false
	}
	removed := false
	for c := range clients {
		if _, ok := set[c]; ok {
			delete(set, c)
			removed = true
		}
	}
	if len(set) == 0 {
		delete(h.channels, channelID)
	}
	return removed
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
