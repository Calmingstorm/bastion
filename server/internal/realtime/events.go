package realtime

const (
	EventMessageCreate    = "MESSAGE_CREATE"
	EventMessageUpdate    = "MESSAGE_UPDATE"
	EventMessageDelete    = "MESSAGE_DELETE"
	EventTypingStart      = "TYPING_START"
	EventPresenceUpdate   = "PRESENCE_UPDATE"
	EventServerMemberJoin = "SERVER_MEMBER_JOIN"
	EventMemberKick       = "MEMBER_KICK"
	EventMemberBan        = "MEMBER_BAN"
	EventNotification     = "NOTIFICATION"
)

type Event struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}
