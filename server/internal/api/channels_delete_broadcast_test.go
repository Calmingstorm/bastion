package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/Calmingstorm/bastion/server/internal/api"
	"github.com/Calmingstorm/bastion/server/internal/permissions"
	"github.com/Calmingstorm/bastion/server/internal/testutil"
	"github.com/google/uuid"
)

// TestChannelDeleteBroadcastsOnlyAfterCommit: CHANNEL_DELETE must be broadcast
// AFTER the row is deleted, never before. Broadcasting first had two failure
// modes: a fetch racing the broadcast-to-commit window could read the channel
// back into existence on clients, and a delete that failed after broadcasting
// left every connected client having removed a channel that still exists, with
// no correcting event ever coming. The observable contract: a delete that does
// not delete (404 here) emits NO event; a successful delete emits exactly one.
func TestChannelDeleteBroadcastsOnlyAfterCommit(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	doomedID := h.CreateChannel(owner, serverID, "doomed")

	ws := h.DialWS(owner)
	ws.Drain(400 * time.Millisecond) // discard connect/presence/join noise

	// A delete that fails (unknown channel id) must broadcast nothing.
	missing := uuid.NewString()
	if code := h.Request(http.MethodDelete,
		"/api/v1/servers/"+serverID+"/channels/"+missing, owner.AccessToken, nil, nil); code != http.StatusNotFound {
		t.Fatalf("deleting a missing channel: expected 404, got %d", code)
	}
	if n := ws.CountEvents("CHANNEL_DELETE", 600*time.Millisecond); n != 0 {
		t.Fatalf("a failed delete must not broadcast CHANNEL_DELETE, got %d", n)
	}

	// A successful delete broadcasts exactly once.
	if code := h.Request(http.MethodDelete,
		"/api/v1/servers/"+serverID+"/channels/"+doomedID, owner.AccessToken, nil, nil); code != http.StatusOK {
		t.Fatalf("deleting an existing channel: expected 200, got %d", code)
	}
	if n := ws.CountEvents("CHANNEL_DELETE", 800*time.Millisecond); n != 1 {
		t.Fatalf("a successful delete should broadcast exactly once, got %d", n)
	}
}

// TestChannelDeleteFanoutOncePerMember: server-scoped events are delivered per
// MEMBER, not per channel. Channel fanout had two reproducible failures once
// deletes broadcast after commit: a member subscribed to several surviving
// channels received duplicate CHANNEL_DELETE events, and a client subscribed
// only to the deleted channel received none (the fanout targets were queried
// after the row was gone).
func TestChannelDeleteFanoutOncePerMember(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	// Several surviving channels: per-channel fanout would deliver one event
	// per survivor to the same member.
	h.CreateChannel(owner, serverID, "alpha")
	h.CreateChannel(owner, serverID, "beta")
	doomedID := h.CreateChannel(owner, serverID, "doomed")

	ws := h.DialWS(owner)
	ws.Drain(400 * time.Millisecond)

	if code := h.Request(http.MethodDelete,
		"/api/v1/servers/"+serverID+"/channels/"+doomedID, owner.AccessToken, nil, nil); code != http.StatusOK {
		t.Fatalf("delete: expected 200, got %d", code)
	}
	if n := ws.CountEvents("CHANNEL_DELETE", 800*time.Millisecond); n != 1 {
		t.Fatalf("a member must receive CHANNEL_DELETE exactly once regardless of channel count, got %d", n)
	}
}

// TestChannelEventsOnlyToAuthorizedMembers: channel events go to the
// deduplicated AUTHORIZED recipient set, not raw membership. A member whose
// ViewChannel was revoked must receive no CHANNEL_CREATE/UPDATE/DELETE --
// create and update payloads carry channel metadata that would otherwise leak,
// and a create would install the hidden channel into client state. Every
// event's recipient set is evaluated at delivery time.
func TestChannelEventsOnlyToAuthorizedMembers(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	hidden := h.Register("hidden")
	serverID := h.CreateServer(owner, "S")
	joinServer(h, owner, hidden, serverID)

	// Revoke visibility for ordinary members (the owner sees everything).
	def := defaultRoleID(h, owner, serverID)
	if code := patchRolePerms(h, owner, serverID, def, permissions.SendMessages); code != http.StatusOK {
		t.Fatalf("strip ViewChannel: got %d", code)
	}

	wsOwner := h.DialWS(owner)
	wsHidden := h.DialWS(hidden)
	wsOwner.Drain(400 * time.Millisecond)
	wsHidden.Drain(400 * time.Millisecond)

	// Act-then-assert per event: CountEvents drains the socket's event queue,
	// so each window must contain only its own event.
	chID := h.CreateChannel(owner, serverID, "secret")
	if n := wsOwner.CountEvents("CHANNEL_CREATE", 700*time.Millisecond); n != 1 {
		t.Fatalf("owner should receive CHANNEL_CREATE exactly once, got %d", n)
	}
	if n := wsHidden.CountEvents("CHANNEL_CREATE", 400*time.Millisecond); n != 0 {
		t.Fatalf("a member without ViewChannel must receive no CHANNEL_CREATE, got %d", n)
	}

	if code := h.Request(http.MethodPatch,
		"/api/v1/servers/"+serverID+"/channels/"+chID, owner.AccessToken,
		map[string]string{"name": "renamed"}, nil); code != http.StatusOK {
		t.Fatalf("update channel: got %d", code)
	}
	if n := wsOwner.CountEvents("CHANNEL_UPDATE", 700*time.Millisecond); n != 1 {
		t.Fatalf("owner should receive CHANNEL_UPDATE exactly once, got %d", n)
	}
	if n := wsHidden.CountEvents("CHANNEL_UPDATE", 400*time.Millisecond); n != 0 {
		t.Fatalf("a member without ViewChannel must receive no CHANNEL_UPDATE, got %d", n)
	}

	if code := h.Request(http.MethodDelete,
		"/api/v1/servers/"+serverID+"/channels/"+chID, owner.AccessToken, nil, nil); code != http.StatusOK {
		t.Fatalf("delete channel: got %d", code)
	}
	if n := wsOwner.CountEvents("CHANNEL_DELETE", 700*time.Millisecond); n != 1 {
		t.Fatalf("owner should receive CHANNEL_DELETE exactly once, got %d", n)
	}
	if n := wsHidden.CountEvents("CHANNEL_DELETE", 400*time.Millisecond); n != 0 {
		t.Fatalf("a member without ViewChannel must receive no CHANNEL_DELETE, got %d", n)
	}
}

// TestBackdatedBotMentionNotifiesWithEmissionTime: bots may backdate a
// message's createdAt (a presentation timestamp), so it is NOT a causal
// watermark -- unread reconciliation compares the notification's time against
// lastReadAt, and treating a backdated mention as pre-acknowledgment would
// silently swallow a genuinely new event. The NOTIFICATION must carry the
// server's own emission time.
func TestBackdatedBotMentionNotifiesWithEmissionTime(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)
	_, _, botToken := createBotFull(t, h, owner, serverID)

	ws := h.DialWS(member)
	ws.Drain(400 * time.Millisecond)

	before := time.Now().UTC().Add(-2 * time.Second)
	backdated := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano)
	if code := h.RequestAuth(http.MethodPost,
		"/api/v1/channels/"+channelID+"/messages", "Bot "+botToken,
		map[string]any{"content": "@member ping", "createdAt": backdated}, nil); code != http.StatusCreated {
		t.Fatalf("backdated bot mention: expected 201, got %d", code)
	}
	evs := ws.MatchingEvents("NOTIFICATION", 900*time.Millisecond)
	if len(evs) == 0 {
		t.Fatal("mention should deliver a NOTIFICATION")
	}
	var ev struct {
		Data struct {
			CreatedAt time.Time `json:"createdAt"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(evs[0]), &ev); err != nil {
		t.Fatalf("unmarshal notification: %v", err)
	}
	if !ev.Data.CreatedAt.After(before) {
		t.Fatalf("notification must carry the EMISSION time, got backdated %s", ev.Data.CreatedAt)
	}
}

// TestNewChannelDeliversMessagesToConnectedClients: creating a channel must
// SUBSCRIBE already-connected authorized clients, not just announce it --
// without the subscription, messages in the new channel silently never reach
// them until reconnect.
func TestNewChannelDeliversMessagesToConnectedClients(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	joinServer(h, owner, member, serverID)

	ws := h.DialWS(member) // connected BEFORE the channel exists
	ws.Drain(400 * time.Millisecond)

	chID := h.CreateChannel(owner, serverID, "fresh")
	if n := ws.CountEvents("CHANNEL_CREATE", 700*time.Millisecond); n != 1 {
		t.Fatalf("member should be told about the new channel, got %d", n)
	}
	if code := postTextMessage(h, owner, chID, "first post"); code != http.StatusCreated {
		t.Fatalf("post: expected 201, got %d", code)
	}
	if n := ws.CountEvents("MESSAGE_CREATE", 800*time.Millisecond); n != 1 {
		t.Fatalf("a message in the new channel must reach the connected member without reconnect, got %d", n)
	}
}

// TestServerCreateSubscribesConnectedOwner: the same gap on the server-create
// path -- an already-connected owner must receive messages in their brand-new
// server's default channel without reconnecting.
func TestServerCreateSubscribesConnectedOwner(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")

	ws := h.DialWS(owner) // connected BEFORE the server exists
	ws.Drain(400 * time.Millisecond)

	serverID := h.CreateServer(owner, "Fresh")
	// Use the DEFAULT channel created inside the server-create transaction --
	// creating another channel through the channel-create API would subscribe
	// the owner via THAT path and leave this regression green with the
	// server-create fix removed.
	var channels []struct {
		ID string `json:"id"`
	}
	if code := h.Request(http.MethodGet, "/api/v1/servers/"+serverID+"/channels",
		owner.AccessToken, nil, &channels); code != http.StatusOK || len(channels) == 0 {
		t.Fatalf("list channels: code %d, %d channels", code, len(channels))
	}
	ws.Drain(400 * time.Millisecond) // discard any create announcements
	if code := postTextMessage(h, owner, channels[0].ID, "hello"); code != http.StatusCreated {
		t.Fatalf("post: expected 201, got %d", code)
	}
	if n := ws.CountEvents("MESSAGE_CREATE", 800*time.Millisecond); n != 1 {
		t.Fatalf("the connected owner must receive messages in the new server without reconnect, got %d", n)
	}
}

// TestRevokedMemberGetsNoDeleteEvent: event authorization is evaluated at
// DELIVERY time. The revocation lands INSIDE the delete request -- between the
// commit and the fanout, via the test seam -- so a recipient set captured any
// earlier would still contain the revoked member and leak the event. This is
// the deterministic form of the locked-row race.
func TestRevokedMemberGetsNoDeleteEvent(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	joinServer(h, owner, member, serverID)

	ws := h.DialWS(member)
	ws.Drain(400 * time.Millisecond)

	chID := h.CreateChannel(owner, serverID, "doomed")
	if n := ws.CountEvents("CHANNEL_CREATE", 700*time.Millisecond); n != 1 {
		t.Fatalf("member was authorized at create time, got %d events", n)
	}

	def := defaultRoleID(h, owner, serverID)
	api.AfterChannelDeleteExecForTest = func() {
		// Revoke ViewChannel inside the delete request, after its commit but
		// before recipients are computed.
		if code := patchRolePerms(h, owner, serverID, def, permissions.SendMessages); code != http.StatusOK {
			t.Errorf("revoke ViewChannel: got %d", code)
		}
	}
	t.Cleanup(func() { api.AfterChannelDeleteExecForTest = nil })

	if code := h.Request(http.MethodDelete,
		"/api/v1/servers/"+serverID+"/channels/"+chID, owner.AccessToken, nil, nil); code != http.StatusOK {
		t.Fatalf("delete: expected 200, got %d", code)
	}
	if n := ws.CountEvents("CHANNEL_DELETE", 600*time.Millisecond); n != 0 {
		t.Fatalf("a member revoked before the fanout must receive nothing, got %d", n)
	}
}

// TestAckStoresSeqWatermark: the acknowledgment records the acked message's
// database-assigned seq, and a later (even backdated) mention notifies with a
// HIGHER seq -- the end-to-end watermark contract the client's unread state
// relies on. Wall clocks appear nowhere in the comparison.
func TestAckStoresSeqWatermark(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)
	_, _, botToken := createBotFull(t, h, owner, serverID)

	msgID := sendMessage(h, owner, channelID, "read me")
	if code := h.Request(http.MethodPost, "/api/v1/channels/"+channelID+"/ack",
		member.AccessToken, map[string]string{"messageId": msgID}, nil); code != http.StatusOK {
		t.Fatalf("ack: got %d", code)
	}
	var states []struct {
		ChannelID   string `json:"channelId"`
		LastReadSeq *int64 `json:"lastReadSeq"`
	}
	if code := h.Request(http.MethodGet, "/api/v1/users/me/read-states",
		member.AccessToken, nil, &states); code != http.StatusOK {
		t.Fatalf("read-states: got %d", code)
	}
	var ackedSeq *int64
	for _, rs := range states {
		if rs.ChannelID == channelID {
			ackedSeq = rs.LastReadSeq
		}
	}
	if ackedSeq == nil {
		t.Fatal("the ack must store the acked message's seq as the read watermark")
	}

	ws := h.DialWS(member)
	ws.Drain(400 * time.Millisecond)
	backdated := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano)
	if code := h.RequestAuth(http.MethodPost,
		"/api/v1/channels/"+channelID+"/messages", "Bot "+botToken,
		map[string]any{"content": "@member ping", "createdAt": backdated}, nil); code != http.StatusCreated {
		t.Fatalf("backdated bot mention: expected 201, got %d", code)
	}
	evs := ws.MatchingEvents("NOTIFICATION", 900*time.Millisecond)
	if len(evs) == 0 {
		t.Fatal("mention should deliver a NOTIFICATION")
	}
	var ev struct {
		Data struct {
			Seq int64 `json:"seq"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(evs[0]), &ev); err != nil {
		t.Fatalf("unmarshal notification: %v", err)
	}
	if ev.Data.Seq <= *ackedSeq {
		t.Fatalf("a post-ack write must carry a seq above the read watermark (%d), got %d", *ackedSeq, ev.Data.Seq)
	}
}

// TestMentionNotificationCarriesCreatedAt: the NOTIFICATION payload carries the
// message's server-minted createdAt, so clients can drop a DELAYED notification
// whose message an acknowledgment already covered (client and server clocks are
// never compared -- without this field the delayed-notification flag
// resurrection is unfixable client-side on this event).
func TestMentionNotificationCarriesCreatedAt(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)

	ws := h.DialWS(member)
	ws.Drain(400 * time.Millisecond)

	if code := postTextMessage(h, owner, channelID, "@member ping"); code != http.StatusCreated {
		t.Fatalf("mention: expected 201, got %d", code)
	}
	evs := ws.MatchingEvents("NOTIFICATION", 800*time.Millisecond)
	if len(evs) == 0 {
		t.Fatal("mention should deliver a NOTIFICATION")
	}
	var ev struct {
		Data struct {
			CreatedAt string `json:"createdAt"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(evs[0]), &ev); err != nil {
		t.Fatalf("unmarshal notification: %v", err)
	}
	if ev.Data.CreatedAt == "" {
		t.Fatal("NOTIFICATION must carry the server-minted createdAt")
	}
	if _, err := time.Parse(time.RFC3339Nano, ev.Data.CreatedAt); err != nil {
		t.Fatalf("createdAt must be RFC3339: %v", err)
	}
}

// TestAckWatermarkNeverRegresses: a stale ack response (an OLDER message acked
// after a newer one, e.g. two devices racing) must not move the read watermark
// backwards -- the upsert takes the greatest seq.
func TestAckWatermarkNeverRegresses(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")

	oldID := sendMessage(h, owner, channelID, "old")
	newID := sendMessage(h, owner, channelID, "new")

	ack := func(id string) {
		if code := h.Request(http.MethodPost, "/api/v1/channels/"+channelID+"/ack",
			owner.AccessToken, map[string]string{"messageId": id}, nil); code != http.StatusOK {
			t.Fatalf("ack %s: got %d", id, code)
		}
	}
	readSeq := func() int64 {
		var states []struct {
			ChannelID   string `json:"channelId"`
			LastReadSeq *int64 `json:"lastReadSeq"`
		}
		if code := h.Request(http.MethodGet, "/api/v1/users/me/read-states",
			owner.AccessToken, nil, &states); code != http.StatusOK {
			t.Fatalf("read-states: got %d", code)
		}
		for _, rs := range states {
			if rs.ChannelID == channelID && rs.LastReadSeq != nil {
				return *rs.LastReadSeq
			}
		}
		t.Fatal("no read watermark recorded")
		return 0
	}

	ack(newID)
	high := readSeq()

	// A mention lands after the ack; then a STALE ack (the older message)
	// arrives. The gated upsert must no-op entirely: the watermark holds AND the
	// newer mention state survives (an ungated update would zero it).
	if _, err := h.Pool.Exec(context.Background(),
		`UPDATE read_states SET mention_count = 1 WHERE channel_id = $1`, channelID); err != nil {
		t.Fatalf("seed mention: %v", err)
	}
	ack(oldID) // the stale ack lands second
	if got := readSeq(); got != high {
		t.Fatalf("the watermark must not regress: had %d, got %d", high, got)
	}
	var mentions int
	if err := h.Pool.QueryRow(context.Background(),
		`SELECT mention_count FROM read_states WHERE channel_id = $1`, channelID).Scan(&mentions); err != nil {
		t.Fatalf("read mentions: %v", err)
	}
	if mentions != 1 {
		t.Fatalf("a stale ack must not erase newer mention state, got count %d", mentions)
	}
}

// TestCreateRaceRevocationIsCorrected: a ViewChannel revocation landing between
// the create's subscription loop and its post-check (via the test seam) must
// leave the member unsubscribed -- messages in the new channel do not reach a
// socket whose authorization was revoked mid-create.
func TestCreateRaceRevocationIsCorrected(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	joinServer(h, owner, member, serverID)

	ws := h.DialWS(member)
	ws.Drain(400 * time.Millisecond)

	def := defaultRoleID(h, owner, serverID)
	api.AfterChannelCreateSubscribeForTest = func() {
		if code := patchRolePerms(h, owner, serverID, def, permissions.SendMessages); code != http.StatusOK {
			t.Errorf("revoke ViewChannel: got %d", code)
		}
	}
	t.Cleanup(func() { api.AfterChannelCreateSubscribeForTest = nil })

	chID := h.CreateChannel(owner, serverID, "contested")
	// The revoked member must receive neither the announcement nor messages.
	if n := ws.CountEvents("CHANNEL_CREATE", 500*time.Millisecond); n != 0 {
		t.Fatalf("revoked member must not be announced to, got %d", n)
	}
	if code := postTextMessage(h, owner, chID, "secret"); code != http.StatusCreated {
		t.Fatalf("post: expected 201, got %d", code)
	}
	if n := ws.CountEvents("MESSAGE_CREATE", 600*time.Millisecond); n != 0 {
		t.Fatalf("revoked member must not receive messages in the contested channel, got %d", n)
	}
}

// TestInsertLockSerializesPerChannel: the message-insert advisory lock is the
// seq-order = commit-order guarantee. Proven by BLOCKING (the pin-cap lesson:
// hold the lock externally and assert the insert cannot proceed until release),
// not by timing.
func TestInsertLockSerializesPerChannel(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")

	// Hold the channel's insert lock in an external transaction.
	ctx := context.Background()
	tx, err := h.Pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtext('msg-insert:' || $1))`, channelID); err != nil {
		t.Fatalf("hold lock: %v", err)
	}

	done := make(chan int, 1)
	go func() { done <- postTextMessage(h, owner, channelID, "blocked") }()

	select {
	case code := <-done:
		t.Fatalf("insert must block while the channel lock is held, returned %d", code)
	case <-time.After(700 * time.Millisecond):
		// Blocked, as required.
	}
	_ = tx.Rollback(ctx) // release
	select {
	case code := <-done:
		if code != http.StatusCreated {
			t.Fatalf("insert after release: expected 201, got %d", code)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("insert did not complete after the lock was released")
	}
}

// TestMentionIncrementRespectsWatermark: processMentions runs after the insert
// commits and after the broadcast, so an ack of that very message can land
// FIRST (open channel auto-ack, a second device). The increment is gated on the
// member's read watermark -- ungated, it would wedge a phantom badge forever,
// since re-acking the same message is a deliberate no-op. The replay below runs
// the exact production query with the message's own seq.
func TestMentionIncrementRespectsWatermark(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)

	// The ack lands INSIDE processMentions, after the message committed and
	// broadcast but before the increment runs -- via the seam, so the exact
	// production statement executes against a watermark that already covers it.
	api.BeforeMentionIncrementForTest = func() {
		var msgID string
		if err := h.Pool.QueryRow(context.Background(),
			`SELECT id FROM messages WHERE channel_id = $1 ORDER BY seq DESC LIMIT 1`,
			channelID).Scan(&msgID); err != nil {
			t.Errorf("read message: %v", err)
			return
		}
		if code := h.Request(http.MethodPost, "/api/v1/channels/"+channelID+"/ack",
			member.AccessToken, map[string]string{"messageId": msgID}, nil); code != http.StatusOK {
			t.Errorf("ack: got %d", code)
		}
	}
	t.Cleanup(func() { api.BeforeMentionIncrementForTest = nil })

	if code := postTextMessage(h, owner, channelID, "@member ping"); code != http.StatusCreated {
		t.Fatalf("mention: expected 201, got %d", code)
	}
	var count int
	if err := h.Pool.QueryRow(context.Background(),
		`SELECT mention_count FROM read_states WHERE user_id = $1 AND channel_id = $2`,
		member.ID, channelID).Scan(&count); err != nil {
		t.Fatalf("read count: %v", err)
	}
	if count != 0 {
		t.Fatalf("a mention already inside the watermark must not re-badge, got %d", count)
	}
}

// TestServerDeleteBroadcastsOnlyAfterCommit: SERVER_DELETE follows the same
// contract as channel deletion -- broadcast only after the row is gone (a
// failed delete desyncs nothing), exactly once per member.
func TestServerDeleteBroadcastsOnlyAfterCommit(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	h.CreateChannel(owner, serverID, "extra") // several channels: fanout must still be once
	joinServer(h, owner, member, serverID)

	ws := h.DialWS(member)
	ws.Drain(400 * time.Millisecond)

	if code := h.Request(http.MethodDelete, "/api/v1/servers/"+serverID,
		owner.AccessToken, nil, nil); code != http.StatusOK {
		t.Fatalf("delete server: expected 200, got %d", code)
	}
	if n := ws.CountEvents("SERVER_DELETE", 800*time.Millisecond); n != 1 {
		t.Fatalf("a member must receive SERVER_DELETE exactly once, got %d", n)
	}
}
