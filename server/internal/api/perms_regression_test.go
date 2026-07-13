package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/Calmingstorm/bastion/server/internal/permissions"
	"github.com/Calmingstorm/bastion/server/internal/testutil"
)

func createBot(h *testutil.Harness, owner *testutil.TestUser, serverID, username string) string {
	h.T.Helper()
	var bot struct {
		Token string `json:"token"`
	}
	code := h.Request(http.MethodPost, "/api/v1/servers/"+serverID+"/bots", owner.AccessToken,
		map[string]string{"username": username}, &bot)
	if code != http.StatusCreated {
		h.T.Fatalf("create bot: expected 201, got %d", code)
	}
	if bot.Token == "" {
		h.T.Fatal("bot token empty")
	}
	return bot.Token
}

func bulkImport(h *testutil.Harness, botToken, channelID string) int {
	return h.RequestAuth(http.MethodPost, "/api/v1/channels/"+channelID+"/import", "Bot "+botToken,
		[]map[string]any{{"content": "imported message"}}, nil)
}

func editMessage(h *testutil.Harness, u *testutil.TestUser, channelID, messageID, content string) int {
	return h.Request(http.MethodPut, "/api/v1/channels/"+channelID+"/messages/"+messageID, u.AccessToken,
		map[string]string{"content": content}, nil)
}

func mintInvite(h *testutil.Harness, owner *testutil.TestUser, serverID string) string {
	h.T.Helper()
	var inv struct {
		Code string `json:"code"`
	}
	if code := h.Request(http.MethodPost, "/api/v1/servers/"+serverID+"/invites", owner.AccessToken, map[string]any{}, &inv); code != http.StatusCreated && code != http.StatusOK {
		h.T.Fatalf("mint invite: got %d", code)
	}
	return inv.Code
}

// TestBotBulkImportRequiresSendMessages: a bot must carry the default role (so it
// can write at all), and stripping SendMessages from that role must block import.
func TestBotBulkImportRequiresSendMessages(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	botToken := createBot(h, owner, serverID, "importer")

	// A freshly created bot receives the default @bastion role, so it can import.
	if code := bulkImport(h, botToken, channelID); code != http.StatusCreated {
		t.Fatalf("bot import with default role: expected 201, got %d", code)
	}

	// Strip SendMessages from the default role; the bot inherits only that role.
	def := defaultRoleID(h, owner, serverID)
	if code := patchRolePerms(h, owner, serverID, def, permissions.ViewChannel|permissions.CreateInvites|permissions.AttachFiles); code != http.StatusOK {
		t.Fatalf("strip SendMessages: got %d", code)
	}
	if code := bulkImport(h, botToken, channelID); code != http.StatusForbidden {
		t.Fatalf("bot import without SendMessages: expected 403, got %d", code)
	}
}

// TestUploadRequiresAttachFiles: the upload route must require AttachFiles when
// files are present, independently of SendMessages, so a member who can send text
// but has AttachFiles removed cannot attach.
func TestUploadRequiresAttachFiles(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)

	// Keep ViewChannel + SendMessages; remove only AttachFiles.
	def := defaultRoleID(h, owner, serverID)
	if code := patchRolePerms(h, owner, serverID, def, permissions.ViewChannel|permissions.SendMessages|permissions.CreateInvites); code != http.StatusOK {
		t.Fatalf("strip AttachFiles: got %d", code)
	}

	resp := uploadFile(t, h, "/api/v1/channels/"+channelID+"/messages/upload", member.AccessToken,
		"files", "x.png", "image/png", pngPixel, map[string]string{"content": "hi"})
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("upload without AttachFiles: expected 403, got %d", resp.StatusCode)
	}
}

// TestReactionRequiresViewChannel: adding or removing a reaction in a channel the
// member can no longer view must be rejected, even with a known message ID.
func TestReactionRequiresViewChannel(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)

	msgID := sendMessage(h, owner, channelID, "react to me")

	// Control: with ViewChannel, the member can react.
	if code := addReaction(h, member, channelID, msgID, thumbsUp); code != http.StatusOK {
		t.Fatalf("react with ViewChannel: expected 200, got %d", code)
	}

	// Strip ViewChannel from the default role.
	def := defaultRoleID(h, owner, serverID)
	if code := patchRolePerms(h, owner, serverID, def, permissions.SendMessages|permissions.CreateInvites|permissions.AttachFiles); code != http.StatusOK {
		t.Fatalf("strip ViewChannel: got %d", code)
	}
	if code := addReaction(h, member, channelID, msgID, thumbsUp); code != http.StatusForbidden {
		t.Fatalf("add reaction without ViewChannel: expected 403, got %d", code)
	}
	if code := removeReaction(h, member, channelID, msgID, thumbsUp); code != http.StatusForbidden {
		t.Fatalf("remove reaction without ViewChannel: expected 403, got %d", code)
	}
}

// TestEditRequiresSendMessages: a member who authored a message and then lost
// SendMessages must not be able to edit it (a muted member cannot rewrite history).
func TestEditRequiresSendMessages(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)

	msgID := sendMessage(h, member, channelID, "original")

	// Control: the author can edit while they still have SendMessages.
	if code := editMessage(h, member, channelID, msgID, "edited once"); code != http.StatusOK {
		t.Fatalf("edit with SendMessages: expected 200, got %d", code)
	}

	// Strip SendMessages (keep ViewChannel) — editing must now fail.
	def := defaultRoleID(h, owner, serverID)
	if code := patchRolePerms(h, owner, serverID, def, permissions.ViewChannel|permissions.CreateInvites|permissions.AttachFiles); code != http.StatusOK {
		t.Fatalf("strip SendMessages: got %d", code)
	}
	if code := editMessage(h, member, channelID, msgID, "edited twice"); code != http.StatusForbidden {
		t.Fatalf("edit without SendMessages: expected 403, got %d", code)
	}
}

// TestChannelListHidesHiddenChannels: channel discovery must only return channels
// the member may view, so hidden channel IDs, names, and topics do not leak.
func TestChannelListHidesHiddenChannels(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "secret")
	joinServer(h, owner, member, serverID)

	type ch struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}

	// Control: with ViewChannel the member sees the channel.
	var before []ch
	if code := h.Request(http.MethodGet, "/api/v1/servers/"+serverID+"/channels", member.AccessToken, nil, &before); code != http.StatusOK {
		t.Fatalf("list channels: expected 200, got %d", code)
	}
	found := false
	for _, c := range before {
		if c.ID == channelID {
			found = true
		}
	}
	if !found {
		t.Fatal("member should see the channel by default")
	}

	// Strip ViewChannel — discovery must no longer expose the channel.
	def := defaultRoleID(h, owner, serverID)
	if code := patchRolePerms(h, owner, serverID, def, permissions.SendMessages|permissions.CreateInvites|permissions.AttachFiles); code != http.StatusOK {
		t.Fatalf("strip ViewChannel: got %d", code)
	}
	var after []ch
	if code := h.Request(http.MethodGet, "/api/v1/servers/"+serverID+"/channels", member.AccessToken, nil, &after); code != http.StatusOK {
		t.Fatalf("list channels after strip: expected 200, got %d", code)
	}
	for _, c := range after {
		if c.ID == channelID {
			t.Fatalf("hidden channel %q leaked via discovery", c.Name)
		}
	}

	// The owner still sees everything.
	var ownerView []ch
	if code := h.Request(http.MethodGet, "/api/v1/servers/"+serverID+"/channels", owner.AccessToken, nil, &ownerView); code != http.StatusOK {
		t.Fatalf("owner list: expected 200, got %d", code)
	}
	if len(ownerView) == 0 {
		t.Fatal("owner should still see the channel")
	}
}

// TestMentionDoesNotNotifyHiddenChannelMember: mentioning a member in a channel
// they cannot view must not deliver a NOTIFICATION carrying the channel name and
// a content snippet.
func TestMentionDoesNotNotifyHiddenChannelMember(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")
	joinServer(h, owner, member, serverID)

	ws := h.DialWS(member)
	ws.Drain(400 * time.Millisecond)

	// Control: while viewable, a mention notifies the member.
	if code := postTextMessage(h, owner, channelID, "@member hello there"); code != http.StatusCreated {
		t.Fatalf("owner mention: expected 201, got %d", code)
	}
	if n := ws.CountEvents("NOTIFICATION", 700*time.Millisecond); n == 0 {
		t.Fatal("member should be notified of a mention in a viewable channel")
	}

	// Strip ViewChannel — a mention must no longer notify.
	def := defaultRoleID(h, owner, serverID)
	if code := patchRolePerms(h, owner, serverID, def, permissions.SendMessages|permissions.CreateInvites|permissions.AttachFiles); code != http.StatusOK {
		t.Fatalf("strip ViewChannel: got %d", code)
	}
	ws.Drain(300 * time.Millisecond)
	if code := postTextMessage(h, owner, channelID, "@member secret ping"); code != http.StatusCreated {
		t.Fatalf("owner mention 2: expected 201, got %d", code)
	}
	if n := ws.CountEvents("NOTIFICATION", 700*time.Millisecond); n != 0 {
		t.Fatalf("member received %d NOTIFICATION events for a hidden channel, want 0", n)
	}
}

// TestInviteJoinWithOpenWSDoesNotSubscribeHidden: joining by invite with an
// already-connected socket must not subscribe the client to channels it cannot
// view.
func TestInviteJoinWithOpenWSDoesNotSubscribeHidden(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")

	// The default role cannot view any channel.
	def := defaultRoleID(h, owner, serverID)
	if code := patchRolePerms(h, owner, serverID, def, permissions.SendMessages|permissions.CreateInvites|permissions.AttachFiles); code != http.StatusOK {
		t.Fatalf("strip ViewChannel: got %d", code)
	}

	// Member connects first, then redeems the invite.
	ws := h.DialWS(member)
	ws.Drain(400 * time.Millisecond)

	code := mintInvite(h, owner, serverID)
	if jc := h.Request(http.MethodPost, "/api/v1/invites/"+code+"/join", member.AccessToken, nil, nil); jc != http.StatusOK && jc != http.StatusCreated {
		t.Fatalf("join via invite: got %d", jc)
	}

	_ = postTextMessage(h, owner, channelID, "post-join message")
	if n := ws.CountEvents("MESSAGE_CREATE", 700*time.Millisecond); n != 0 {
		t.Fatalf("invite-joined member received %d MESSAGE_CREATE for a hidden channel, want 0", n)
	}
}

// TestPublicJoinWithOpenWSDoesNotSubscribeHidden: the direct server-join path has
// the same requirement as the invite path.
func TestPublicJoinWithOpenWSDoesNotSubscribeHidden(t *testing.T) {
	h := testutil.New(t)
	owner := h.Register("owner")
	member := h.Register("member")
	serverID := h.CreateServer(owner, "S")
	channelID := h.CreateChannel(owner, serverID, "general")

	def := defaultRoleID(h, owner, serverID)
	if code := patchRolePerms(h, owner, serverID, def, permissions.SendMessages|permissions.CreateInvites|permissions.AttachFiles); code != http.StatusOK {
		t.Fatalf("strip ViewChannel: got %d", code)
	}

	ws := h.DialWS(member)
	ws.Drain(400 * time.Millisecond)

	if jc := h.Request(http.MethodPost, "/api/v1/servers/"+serverID+"/join", member.AccessToken, nil, nil); jc != http.StatusOK && jc != http.StatusCreated {
		t.Fatalf("join public server: got %d", jc)
	}

	_ = postTextMessage(h, owner, channelID, "post-join message")
	if n := ws.CountEvents("MESSAGE_CREATE", 700*time.Millisecond); n != 0 {
		t.Fatalf("public-joined member received %d MESSAGE_CREATE for a hidden channel, want 0", n)
	}
}
