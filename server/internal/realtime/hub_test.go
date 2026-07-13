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
