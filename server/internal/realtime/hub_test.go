package realtime

import (
	"context"
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

	// Connect: register + subscribe atomically, visible immediately.
	hub.RegisterAndSubscribe(client, []uuid.UUID{channelID})
	if !channelHas(hub, channelID, client) {
		t.Fatal("client should be subscribed immediately after RegisterAndSubscribe")
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
			hub.RegisterAndSubscribe(client, []uuid.UUID{channelID})
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
