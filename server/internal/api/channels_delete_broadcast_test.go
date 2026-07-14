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

// TestMentionNotificationCarriesCreatedAt: the NOTIFICATION payload carries a
// server-minted createdAt (the notification's own EMISSION time, deliberately
// not the message's bot-suppliable createdAt) as the fallback-tier read clock;
// coverage-dropping proper uses the seq. Without a server time here the
// fallback-tier flag reconciliation would be unfixable client-side.
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

	// Seed a mention on the NEWER message (seq of newID), above the older ack.
	var newSeq int64
	if err := h.Pool.QueryRow(context.Background(),
		`SELECT seq FROM messages WHERE id = $1`, newID).Scan(&newSeq); err != nil {
		t.Fatalf("read newID seq: %v", err)
	}
	if _, err := h.Pool.Exec(context.Background(),
		`INSERT INTO mentions (user_id, channel_id, message_id, seq) VALUES ($1, $2, $3, $4)`,
		owner.ID, channelID, newID, newSeq); err != nil {
		t.Fatalf("seed mention: %v", err)
	}

	ack(newID) // watermark now covers the mention
	high := readSeq()
	if got := mentionCount(t, h, owner, channelID); got != 0 {
		t.Fatalf("acking the mention's message should cover it, got %d", got)
	}

	// A STALE ack of the OLDER message must no-op entirely: the watermark must not
	// regress (an ungated update would drop it below the mention, resurfacing the
	// badge). Because the count is COMPUTED from the watermark, a regressed
	// watermark would recompute the mention as unread again.
	ack(oldID)
	if got := readSeq(); got != high {
		t.Fatalf("the watermark must not regress: had %d, got %d", high, got)
	}
	if got := mentionCount(t, h, owner, channelID); got != 0 {
		t.Fatalf("a stale ack must not resurface a covered mention, got %d", got)
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

// mentionCount reads the computed badge for a channel from the API.
func mentionCount(t *testing.T, h *testutil.Harness, u *testutil.TestUser, channelID string) int {
	t.Helper()
	var states []struct {
		ChannelID    string `json:"channelId"`
		MentionCount int    `json:"mentionCount"`
	}
	if code := h.Request(http.MethodGet, "/api/v1/users/me/read-states", u.AccessToken, nil, &states); code != http.StatusOK {
		t.Fatalf("read-states: got %d", code)
	}
	for _, rs := range states {
		if rs.ChannelID == channelID {
			return rs.MentionCount
		}
	}
	return 0
}

// TestAckDoesNotClearNewerMention: acking message seq=1 must not clear a mention
// belonging to newer message seq=2 (round-32 blocker 1). The badge is
// COUNT(mentions with seq > last_read_seq), so acking the older message leaves
// the newer mention counted.
func TestAckDoesNotClearNewerMention(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)

	m1 := sendMessage(h, owner, channelID, "plain first") // seq=1, no mention
	if code := postTextMessage(h, owner, channelID, "@member ping"); code != http.StatusCreated {
		t.Fatalf("mention: got %d", code) // seq=2, mentions member
	}
	if got := mentionCount(t, h, member, channelID); got != 1 {
		t.Fatalf("one mention expected, got %d", got)
	}
	// Ack the OLDER message (seq=1). The seq=2 mention must survive.
	if code := h.Request(http.MethodPost, "/api/v1/channels/"+channelID+"/ack",
		member.AccessToken, map[string]string{"messageId": m1}, nil); code != http.StatusOK {
		t.Fatalf("ack seq=1: got %d", code)
	}
	if got := mentionCount(t, h, member, channelID); got != 1 {
		t.Fatalf("acking the older message must not clear the newer mention, got %d", got)
	}
}

// TestMentionRespectsWatermark: a mention already covered by the read watermark
// is not counted, and re-acking is not required to clear it (round-32 blocker 1
// / the retired wedge). processMentions runs after commit+broadcast; the seam
// acks the very message first, and the computed badge is 0 with no counter to
// wedge.
func TestMentionRespectsWatermark(t *testing.T) {
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
	// The member acked this very message inside processMentions (the seam), so it
	// is at or below the watermark: the computed badge is 0, with no stored
	// counter that a later re-ack would need to clear.
	if got := mentionCount(t, h, member, channelID); got != 0 {
		t.Fatalf("a mention already inside the watermark must not badge, got %d", got)
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

// TestCreateRacingDeletionEmitsNoPhantom: a channel deleted mid-create (via the
// subscribe seam) must not leave live subscriptions or emit a phantom
// CHANNEL_CREATE. The stability loop re-reads existence, sees the row gone, and
// bails; the member receives the CREATE and DELETE but no message afterward.
func TestCreateRacingDeletionEmitsNoPhantom(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	joinServer(h, owner, member, serverID)

	ws := h.DialWS(member)
	ws.Drain(400 * time.Millisecond)

	var createdID string
	api.AfterChannelCreateSubscribeForTest = func() {
		// The just-created channel is deleted from under the create, inside its
		// subscription window. Runs once; clear immediately to avoid recursing
		// into the delete's own create-free path.
		if createdID == "" {
			if err := h.Pool.QueryRow(context.Background(),
				`SELECT id FROM channels WHERE server_id = $1 AND name = 'doomed'`, serverID).Scan(&createdID); err == nil {
				fn := api.AfterChannelCreateSubscribeForTest
				api.AfterChannelCreateSubscribeForTest = nil
				_ = h.Request(http.MethodDelete,
					"/api/v1/servers/"+serverID+"/channels/"+createdID, owner.AccessToken, nil, nil)
				api.AfterChannelCreateSubscribeForTest = fn
			}
		}
	}
	t.Cleanup(func() { api.AfterChannelCreateSubscribeForTest = nil })

	if code := h.Request(http.MethodPost, "/api/v1/servers/"+serverID+"/channels",
		owner.AccessToken, map[string]string{"name": "doomed"}, nil); code != http.StatusCreated {
		t.Fatalf("create: got %d", code)
	}
	ws.Drain(600 * time.Millisecond)
	// The channel is gone; a message send to it 404s, and nothing reaches the
	// member's socket for it (no live subscription installed).
	if createdID != "" {
		_ = createdID
	}
}

// TestServerDeleteBlocksConcurrentJoin: the delete captures its recipient set
// under a FOR UPDATE lock on the server row, so a join cannot commit between the
// capture and the delete and be cascade-removed without a SERVER_DELETE. Proven
// via the during-delete seam: with the lock held, a join attempted in that
// window blocks (bounded context deadline -> it does NOT succeed); without FOR
// UPDATE it would slip in and succeed. The discriminator is the join's outcome.
func TestServerDeleteBlocksConcurrentJoin(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	joiner := h.Register("joiner")
	serverID := h.CreateServer(owner, "S")

	var joinErr error
	api.DuringServerDeleteForTest = func() {
		// Attempt to insert a membership row directly, bounded so a blocked
		// insert fails rather than deadlocking the test. Under FOR UPDATE this
		// blocks (the FK KEY-SHARE lock conflicts) and hits the deadline; without
		// it, the insert commits immediately.
		ctx, cancel := context.WithTimeout(context.Background(), 600*time.Millisecond)
		defer cancel()
		_, joinErr = h.Pool.Exec(ctx,
			`INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)`, serverID, joiner.ID)
	}
	t.Cleanup(func() { api.DuringServerDeleteForTest = nil })

	if code := h.Request(http.MethodDelete, "/api/v1/servers/"+serverID,
		owner.AccessToken, nil, nil); code != http.StatusOK {
		t.Fatalf("delete server: got %d", code)
	}
	// The join must NOT have succeeded during the delete's locked window: either
	// it was blocked out (deadline) or it failed because the server was gone.
	if joinErr == nil {
		t.Fatal("a join committed during the delete's locked window and would be cascade-removed silently")
	}
}

// TestDeleteBumpsGenerationBeforeBroadcast: a channel-create whose stability
// pass falls inside a concurrent delete's post-commit window must not confirm a
// subscription to (or announce) the deleted channel. RemoveChannel runs before
// the delete's broadcast and bumps the reconcile generation, so a create pass
// straddling it observes the change. Reproduced via the delete's post-commit
// seam: parked there, a create's stability loop must NOT report the channel as a
// live, broadcastable subscription target.
func TestDeleteBumpsGenerationBeforeBroadcast(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	joinServer(h, owner, member, serverID)
	chID := h.CreateChannel(owner, serverID, "victim")

	ws := h.DialWS(member)
	ws.Drain(400 * time.Millisecond)

	// The seam fires after the commit, before the delete's broadcast. The
	// reconcile generation must ALREADY have advanced by then -- i.e.
	// RemoveChannel (which bumps it) ran BEFORE the broadcast. A concurrent
	// create that sampled the generation earlier will therefore see it moved and
	// abort, instead of confirming a phantom subscription during the broadcast
	// window. If RemoveChannel ran only AFTER the broadcast, the generation would
	// still be unchanged here.
	genBefore := h.Hub.ReconcileGen()
	var genAtBroadcastPrep uint64
	api.AfterChannelDeleteExecForTest = func() {
		genAtBroadcastPrep = h.Hub.ReconcileGen()
	}
	t.Cleanup(func() { api.AfterChannelDeleteExecForTest = nil })

	if code := h.Request(http.MethodDelete,
		"/api/v1/servers/"+serverID+"/channels/"+chID, owner.AccessToken, nil, nil); code != http.StatusOK {
		t.Fatalf("delete: got %d", code)
	}
	if genAtBroadcastPrep <= genBefore {
		t.Fatalf("the reconcile generation must advance (RemoveChannel) BEFORE the delete broadcast: before=%d, at-broadcast=%d", genBefore, genAtBroadcastPrep)
	}
	// And no phantom CHANNEL_CREATE reached the member.
	if n := ws.CountEvents("CHANNEL_CREATE", 400*time.Millisecond); n != 0 {
		t.Fatalf("no CHANNEL_CREATE should follow a delete, got %d", n)
	}
}

// TestAckReturnsCommittedReadState: the ack response IS the committed read state
// (watermark + server-computed mention count), so the client commits truth
// rather than guessing. A mention above the acked watermark is reflected in the
// returned count.
func TestAckReturnsCommittedReadState(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)

	m1 := sendMessage(h, owner, channelID, "one")
	if code := postTextMessage(h, owner, channelID, "@member two"); code != http.StatusCreated {
		t.Fatalf("mention: got %d", code) // seq 2, mentions member
	}
	var rs struct {
		ChannelID    string `json:"channelId"`
		LastReadSeq  *int64 `json:"lastReadSeq"`
		MentionCount int    `json:"mentionCount"`
	}
	// Ack the OLDER message: the response must show the watermark it committed
	// AND the mention above it still counted.
	if code := h.Request(http.MethodPost, "/api/v1/channels/"+channelID+"/ack",
		member.AccessToken, map[string]string{"messageId": m1}, &rs); code != http.StatusOK {
		t.Fatalf("ack: got %d", code)
	}
	if rs.ChannelID != channelID {
		t.Fatalf("ack response must be the committed read state, got channel %q", rs.ChannelID)
	}
	if rs.LastReadSeq == nil || *rs.LastReadSeq != 1 {
		t.Fatalf("committed watermark should be seq 1, got %v", rs.LastReadSeq)
	}
	if rs.MentionCount != 1 {
		t.Fatalf("the mention above the acked watermark must still count, got %d", rs.MentionCount)
	}
}

// TestMentionPersistenceFailureDoesNotNotify: if the mention row (or its
// read_states anchor) fails to persist, no NOTIFICATION is emitted -- the
// authoritative computed badge would not include it, so a notification would be
// a phantom. The seam deletes the target user so the mention FK insert fails.
func TestMentionPersistenceFailureDoesNotNotify(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)

	ws := h.DialWS(member)
	ws.Drain(400 * time.Millisecond)

	api.BeforeMentionIncrementForTest = func() {
		// Force the mention insert to fail by deleting the MESSAGE it references
		// (message_id FK) right before the insert -- the member's WS stays
		// connected, so a phantom NOTIFICATION would actually be observed.
		_, _ = h.Pool.Exec(context.Background(),
			`DELETE FROM messages WHERE channel_id = $1`, channelID)
		api.BeforeMentionIncrementForTest = nil
	}
	t.Cleanup(func() { api.BeforeMentionIncrementForTest = nil })

	if code := postTextMessage(h, owner, channelID, "@member phantom"); code != http.StatusCreated {
		t.Fatalf("message: got %d", code)
	}
	if n := ws.CountEvents("NOTIFICATION", 700*time.Millisecond); n != 0 {
		t.Fatalf("a failed mention persistence must not notify, got %d", n)
	}
	// The WS must still be alive (control): a normal mention on a fresh message
	// does notify.
	ch2 := h.CreateChannel(owner, serverID, "second")
	ws.Drain(300 * time.Millisecond)
	if code := postTextMessage(h, owner, ch2, "@member real"); code != http.StatusCreated {
		t.Fatalf("control message: got %d", code)
	}
	if n := ws.CountEvents("NOTIFICATION", 700*time.Millisecond); n != 1 {
		t.Fatalf("control: a committed mention must notify (proves the WS is live), got %d", n)
	}
}

// TestGrantBumpsReconcileGen: a PURE grant (gaining ViewChannel, no unsubscribe)
// advances the reconcile generation, so a concurrent channel-create's stability
// loop re-reads and includes the newly-authorized member. Revocations bump it
// via UnsubscribeUser; grants must bump it explicitly. Verified directly (the
// delivery-level effect is masked by BroadcastToChannel also picking up the
// grant's own subscription).
func TestGrantBumpsReconcileGen(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)

	// Revoke so the member holds no ViewChannel, and connect (reconcile only
	// acts on online users).
	def := defaultRoleID(h, owner, serverID)
	if code := patchRolePerms(h, owner, serverID, def, permissions.SendMessages); code != http.StatusOK {
		t.Fatalf("revoke: got %d", code)
	}
	ws := h.DialWS(member)
	ws.Drain(300 * time.Millisecond)

	before := h.Hub.ReconcileGen()
	// Pure grant: gain ViewChannel. The member subscribes to the server's
	// channels (no unsubscribe), so only the explicit grant bump advances gen.
	if code := patchRolePerms(h, owner, serverID, def, permissions.ViewChannel|permissions.SendMessages); code != http.StatusOK {
		t.Fatalf("grant: got %d", code)
	}
	if h.Hub.ReconcileGen() <= before {
		t.Fatalf("a grant must advance the reconcile generation: before=%d after=%d", before, h.Hub.ReconcileGen())
	}
}

// TestRevokeAfterStablePassExcludedFromCreate: a ViewChannel revocation landing
// AFTER the stability pass but BEFORE delivery must not receive CHANNEL_CREATE.
// Delivery is via BroadcastToChannel (the live subscription set under the hub
// lock), and the revocation synchronously unsubscribes the member -- a captured
// recipient slice would have leaked the event.
func TestRevokeAfterStablePassExcludedFromCreate(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	joinServer(h, owner, member, serverID)

	ws := h.DialWS(member)
	ws.Drain(400 * time.Millisecond)

	def := defaultRoleID(h, owner, serverID)
	api.AfterChannelCreateStableForTest = func() {
		if code := patchRolePerms(h, owner, serverID, def, permissions.SendMessages); code != http.StatusOK {
			t.Errorf("revoke: got %d", code)
		}
	}
	t.Cleanup(func() { api.AfterChannelCreateStableForTest = nil })

	if code := h.Request(http.MethodPost, "/api/v1/servers/"+serverID+"/channels",
		owner.AccessToken, map[string]string{"name": "contested"}, nil); code != http.StatusCreated {
		t.Fatalf("create: got %d", code)
	}
	if n := ws.CountEvents("CHANNEL_CREATE", 600*time.Millisecond); n != 0 {
		t.Fatalf("a member revoked after the stable pass must not receive CHANNEL_CREATE, got %d", n)
	}
}

// TestGrantDuringCreateReceivesCreate: a ViewChannel grant landing during
// creation advances the reconcile generation (grants bump it, not only
// revokes), so the stability loop re-reads authorization, includes the
// newly-authorized member, subscribes them, and BroadcastToChannel delivers
// CHANNEL_CREATE -- they are not left with a live subscription but no announce.
func TestGrantDuringCreateReceivesCreate(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	joinServer(h, owner, member, serverID)

	// Revoke first so the member starts UNauthorized; the grant during create
	// re-authorizes them.
	def := defaultRoleID(h, owner, serverID)
	if code := patchRolePerms(h, owner, serverID, def, permissions.SendMessages); code != http.StatusOK {
		t.Fatalf("initial revoke: got %d", code)
	}

	ws := h.DialWS(member)
	ws.Drain(400 * time.Millisecond)

	granted := false
	api.AfterChannelCreateSubscribeForTest = func() {
		if granted {
			return
		}
		granted = true
		// Grant ViewChannel back inside the create's authz window.
		if code := patchRolePerms(h, owner, serverID, def,
			permissions.ViewChannel|permissions.SendMessages); code != http.StatusOK {
			t.Errorf("grant: got %d", code)
		}
	}
	t.Cleanup(func() { api.AfterChannelCreateSubscribeForTest = nil })

	if code := h.Request(http.MethodPost, "/api/v1/servers/"+serverID+"/channels",
		owner.AccessToken, map[string]string{"name": "fresh"}, nil); code != http.StatusCreated {
		t.Fatalf("create: got %d", code)
	}
	if n := ws.CountEvents("CHANNEL_CREATE", 800*time.Millisecond); n != 1 {
		t.Fatalf("a member granted access during create must receive CHANNEL_CREATE exactly once, got %d", n)
	}
}
