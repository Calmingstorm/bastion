package realtime

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
)

// newDroppingClient returns a client whose send buffer is always full (an
// unbuffered channel with no reader), so every broadcast to it is dropped.
func newDroppingClient(userID uuid.UUID) *Client {
	return &Client{userID: userID, send: make(chan Event)}
}

// channelHas reports whether a client is currently subscribed to a channel.
func channelHas(h *Hub, channelID uuid.UUID, client *Client) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	set, ok := h.channels[channelID]
	if !ok {
		return false
	}
	_, ok = set[client]
	return ok
}

// TestSubscriptionMutationsAreSynchronous pins the ordering fix: subscribe and
// unsubscribe take effect immediately under the hub lock, with no async queue, so
// a revocation cannot be undone by a subscribe that drains from the hub loop
// afterward. Previously a Subscribe queued before a revocation could be applied
// by Hub.Run after a synchronous revocation returned, resurrecting access.
func TestSubscriptionMutationsAreSynchronous(t *testing.T) {
	hub := NewHub()
	go hub.Run()
	defer hub.Stop()

	userID := uuid.New()
	channelID := uuid.New()
	client := newDroppingClient(userID)

	// Connect: register + subscribe, visible immediately.
	hub.RegisterUser(client)
	hub.Subscribe(channelID, client)
	if !channelHas(hub, channelID, client) {
		t.Fatal("client should be subscribed immediately after Subscribe")
	}

	// Revoke: unsubscribe synchronously, visible immediately.
	hub.UnsubscribeUser(userID, channelID)
	if channelHas(hub, channelID, client) {
		t.Fatal("client should be unsubscribed immediately after UnsubscribeUser")
	}

	// Let the hub loop spin: there is no queued command, so nothing can
	// resurrect the revoked subscription.
	time.Sleep(50 * time.Millisecond)
	if channelHas(hub, channelID, client) {
		t.Fatal("revoked subscription was resurrected by the hub loop")
	}
}

// TestConcurrentSubscribeRevokeNoResurrection hammers connect and revoke on the
// same channel concurrently. Whichever wins the lock last decides the state, but
// a revocation observed after a completed connect must leave the client off — no
// partially-applied connect can survive it. Runs clean under -race.
func TestConcurrentSubscribeRevokeNoResurrection(t *testing.T) {
	hub := NewHub()
	go hub.Run()
	defer hub.Stop()

	userID := uuid.New()
	channelID := uuid.New()

	for i := 0; i < 200; i++ {
		client := newDroppingClient(userID)
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			hub.RegisterUser(client)
			hub.Subscribe(channelID, client)
		}()
		go func() {
			defer wg.Done()
			hub.UnsubscribeUser(userID, channelID)
		}()
		wg.Wait()

		// A final revocation must always win: after both settle, revoke once more
		// and the client must be gone and stay gone.
		hub.UnsubscribeUser(userID, channelID)
		if channelHas(hub, channelID, client) {
			t.Fatalf("iteration %d: client survived a final revocation", i)
		}
		hub.UnsubscribeAll(client)
	}
}

// TestConnectRevalidatesStaleSnapshot models the residual race: a connection reads
// a stale viewable snapshot, a revocation commits and reconciles while the
// connecting client is not yet subscribed, and the connect then applies the stale
// snapshot. The revalidation loop must detect the raced revocation via the
// generation bump and re-read, so the client does NOT end subscribed to the
// revoked channel — and crucially without a second unconditional revocation
// papering over the assertion.
func TestConnectRevalidatesStaleSnapshot(t *testing.T) {
	hub := NewHub()
	go hub.Run()
	defer hub.Stop()

	userID := uuid.New()
	revokedChannel := uuid.New()
	client := newDroppingClient(userID)

	calls := 0
	_, err := hub.ConnectClient(client, func() ([]uuid.UUID, error) {
		calls++
		if calls == 1 {
			// A revocation commits + reconciles right after we read the (stale)
			// snapshot but before the connect checks the generation. The client is
			// registered but not yet subscribed, so the reconcile's UnsubscribeUser
			// is a no-op on the channel — only the generation bump records it.
			hub.UnsubscribeUser(userID, revokedChannel)
			return []uuid.UUID{revokedChannel}, nil // stale: still lists the channel
		}
		return nil, nil // fresh read: the channel is no longer viewable
	})
	if err != nil {
		t.Fatalf("ConnectClient: %v", err)
	}
	if calls < 2 {
		t.Fatalf("expected revalidation to re-read viewability, got %d read(s)", calls)
	}
	if channelHas(hub, revokedChannel, client) {
		t.Fatal("stale pre-revocation snapshot resurrected channel access after reconciliation")
	}
}

// TestConnectFailsClosedOnUnstableGeneration: if every revalidation attempt is
// invalidated by a racing revocation, ConnectClient must not install the final
// stale snapshot on exhaustion — it fails closed and unregisters the client, so
// no stale subscription persists with nothing left to reconcile it.
func TestConnectFailsClosedOnUnstableGeneration(t *testing.T) {
	hub := NewHub()
	go hub.Run()
	defer hub.Stop()

	userID := uuid.New()
	staleChannel := uuid.New()
	client := newDroppingClient(userID)

	// Every read bumps the generation (a revocation) and returns a stale snapshot,
	// so the loop can never observe a stable generation.
	_, err := hub.ConnectClient(client, func() ([]uuid.UUID, error) {
		hub.UnsubscribeUser(userID, uuid.New()) // bump gen on an unrelated channel
		return []uuid.UUID{staleChannel}, nil
	})
	if !errors.Is(err, ErrConnectUnstable) {
		t.Fatalf("expected ErrConnectUnstable, got %v", err)
	}
	if channelHas(hub, staleChannel, client) {
		t.Fatal("exhausted connect left a stale subscription installed")
	}
	if hub.IsUserOnline(userID) {
		t.Fatal("failed connect left the client registered")
	}
}

// TestConnectInitialReadErrorCleansUp: an initial viewability read error must not
// leave the client registered in the hub (ServeWS returns before the pumps that
// would otherwise call UnsubscribeAll).
func TestConnectInitialReadErrorCleansUp(t *testing.T) {
	hub := NewHub()
	go hub.Run()
	defer hub.Stop()

	userID := uuid.New()
	client := newDroppingClient(userID)

	readErr := errors.New("db down")
	_, err := hub.ConnectClient(client, func() ([]uuid.UUID, error) {
		return nil, readErr
	})
	if !errors.Is(err, readErr) {
		t.Fatalf("expected the read error, got %v", err)
	}
	if hub.IsUserOnline(userID) {
		t.Fatal("initial read error left the client registered")
	}
}

// TestConnectRevalidationErrorCleansUp: a read error on a later revalidation
// (after a snapshot was already applied) must clean up both the registration and
// the previously-applied subscriptions.
func TestConnectRevalidationErrorCleansUp(t *testing.T) {
	hub := NewHub()
	go hub.Run()
	defer hub.Stop()

	userID := uuid.New()
	firstChannel := uuid.New()
	client := newDroppingClient(userID)

	readErr := errors.New("db down mid-revalidation")
	calls := 0
	_, err := hub.ConnectClient(client, func() ([]uuid.UUID, error) {
		calls++
		if calls == 1 {
			hub.UnsubscribeUser(userID, uuid.New()) // bump gen to force a revalidation
			return []uuid.UUID{firstChannel}, nil   // applied on the first pass
		}
		return nil, readErr // the revalidation read fails
	})
	if !errors.Is(err, readErr) {
		t.Fatalf("expected the read error, got %v", err)
	}
	if channelHas(hub, firstChannel, client) {
		t.Fatal("revalidation error left the first snapshot's subscription installed")
	}
	if hub.IsUserOnline(userID) {
		t.Fatal("revalidation error left the client registered")
	}
}

// TestBroadcastToUserDropAccounting checks that drops are counted and that the
// write pump's reset is observed. BroadcastToUser is synchronous, so this is
// deterministic and needs neither the hub goroutine nor a live connection.
func TestBroadcastToUserDropAccounting(t *testing.T) {
	hub := NewHub()
	userID := uuid.New()
	client := newDroppingClient(userID)
	hub.RegisterUser(client)

	for i := 0; i < 3; i++ {
		hub.BroadcastToUser(userID, Event{Type: "X"})
	}
	if got := client.dropCount.Load(); got != 3 {
		t.Fatalf("dropCount = %d, want 3", got)
	}

	// Simulate the write pump draining a message: the counter resets.
	client.dropCount.Store(0)
	hub.BroadcastToUser(userID, Event{Type: "X"})
	if got := client.dropCount.Load(); got != 1 {
		t.Fatalf("dropCount after reset = %d, want 1", got)
	}
}

// TestDropCountConcurrentAccessRaceFree drives the exact interleaving that used
// to race: multiple broadcasters incrementing dropCount under the hub's read
// lock while the write pump resets it. It must be clean under -race. The 8-drop
// cap stays below the 10-drop disconnect threshold, so closeSlow (which needs a
// live connection) never fires.
func TestDropCountConcurrentAccessRaceFree(t *testing.T) {
	hub := NewHub()
	userID := uuid.New()
	client := newDroppingClient(userID)
	hub.RegisterUser(client)

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			hub.BroadcastToUser(userID, Event{Type: "X"})
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		client.dropCount.Store(0)
	}()
	wg.Wait()
}

// TestCloseSlowIdempotentUnderFlood floods a client far past the drop threshold
// against a real WebSocket whose peer never completes the close handshake. Only
// one close worker may be launched, and broadcasting must stay prompt.
func TestCloseSlowIdempotentUnderFlood(t *testing.T) {
	serverConnCh := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		serverConnCh <- c
		<-r.Context().Done() // hold the connection open; never ack a close
	}))
	defer srv.Close()

	dialCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	clientConn, resp, err := websocket.Dial(dialCtx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	defer func() { _ = clientConn.CloseNow() }()

	serverConn := <-serverConnCh

	hub := NewHub()
	userID := uuid.New()
	// Unbuffered send with no reader => every broadcast is dropped.
	client := &Client{userID: userID, conn: serverConn, send: make(chan Event)}
	hub.RegisterUser(client)

	start := time.Now()
	for i := 0; i < 500; i++ {
		hub.BroadcastToUser(userID, Event{Type: "X"})
	}
	elapsed := time.Since(start)

	if got := client.closeWorkers.Load(); got != 1 {
		t.Fatalf("expected exactly 1 close worker under flood, got %d", got)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("broadcasting stalled under flood: 500 broadcasts took %v", elapsed)
	}
}

// TestRemoveChannelDropsSubscriberSet: a deleted channel's subscriptions must
// not outlive the row -- they would pin client pointers until those clients
// disconnect, and channel ids are never reused.
func TestRemoveChannelDropsSubscriberSet(t *testing.T) {
	hub := NewHub()
	go hub.Run()
	defer hub.Stop()

	userID := uuid.New()
	channelID := uuid.New()
	client := newDroppingClient(userID)

	hub.RegisterUser(client)
	hub.Subscribe(channelID, client)
	if !channelHas(hub, channelID, client) {
		t.Fatal("subscribe should be visible")
	}
	hub.RemoveChannel(channelID)
	if channelHas(hub, channelID, client) {
		t.Fatal("RemoveChannel must drop the channel's subscriber set")
	}
}

// TestRemoveChannelBumpsReconcileGen: a concurrently CONNECTING client read its
// viewable snapshot while the channel still existed; without a generation bump
// it would install that stale snapshot and resurrect the dead subscription set.
func TestRemoveChannelBumpsReconcileGen(t *testing.T) {
	hub := NewHub()
	go hub.Run()
	defer hub.Stop()

	before := hub.ReconcileGen()
	hub.RemoveChannel(uuid.New())
	if hub.ReconcileGen() == before {
		t.Fatal("RemoveChannel must bump the reconcile generation")
	}
}

// TestSubscribeAuthorizedStableConvergesUnderGenChurn: with a STABLE authorized
// set, SubscribeAuthorizedStable converges even while the reconcile generation
// keeps moving (a spurious/grant bump) -- two agreeing reads confirm membership --
// and KEEPS the subscription installed for live delivery. The prior design rolled
// back and returned ErrConnectUnstable on any generation move, dropping delivery.
func TestSubscribeAuthorizedStableConvergesUnderGenChurn(t *testing.T) {
	hub := NewHub()
	go hub.Run()
	defer hub.Stop()

	userID := uuid.New()
	channelID := uuid.New()
	client := newDroppingClient(userID)
	hub.RegisterUser(client)

	exists, err := hub.SubscribeAuthorizedStable(channelID, func() ([]uuid.UUID, bool, error) {
		// Move the generation on every read; the authorized set stays {userID}.
		hub.BumpReconcileGen()
		return []uuid.UUID{userID}, true, nil
	})
	if err != nil {
		t.Fatalf("a stable authorized set must converge, got err %v", err)
	}
	if !exists {
		t.Fatal("expected exists=true")
	}
	// Delivery reads the LIVE hub set (never a returned slice); assert the member
	// is actually subscribed there, which is what makes live delivery work.
	if !channelHas(hub, channelID, client) {
		t.Fatal("a converged pass must keep the authorized member subscribed for live delivery")
	}
}

// TestSubscribeAuthorizedStableBestEffortOnFlood: if authorization genuinely never
// stabilizes (the set differs on every read), the primitive does NOT error and
// does NOT hang -- it best-efforts within its bounded attempts and returns. The
// caller delivers to the live hub set regardless; a wrongly-included member is
// cleaned up by their own revocation's reconcile.
func TestSubscribeAuthorizedStableBestEffortOnFlood(t *testing.T) {
	hub := NewHub()
	go hub.Run()
	defer hub.Stop()

	channelID := uuid.New()
	exists, err := hub.SubscribeAuthorizedStable(channelID, func() ([]uuid.UUID, bool, error) {
		hub.BumpReconcileGen()
		return []uuid.UUID{uuid.New()}, true, nil // a different set every read
	})
	if err != nil {
		t.Fatalf("a non-stabilizing flood must best-effort, not error, got %v", err)
	}
	if !exists {
		t.Fatal("expected exists=true on best-effort")
	}
}
