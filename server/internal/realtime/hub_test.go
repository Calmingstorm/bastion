package realtime

import (
	"sync"
	"testing"

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
