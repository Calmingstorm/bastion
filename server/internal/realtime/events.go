package realtime

const (
	EventMessageCreate    = "MESSAGE_CREATE"
	EventMessageUpdate    = "MESSAGE_UPDATE"
	EventMessageDelete    = "MESSAGE_DELETE"
	EventChannelCreate    = "CHANNEL_CREATE"
	EventChannelUpdate    = "CHANNEL_UPDATE"
	EventChannelDelete    = "CHANNEL_DELETE"
	EventTypingStart      = "TYPING_START"
	EventPresenceUpdate   = "PRESENCE_UPDATE"
	EventServerMemberJoin = "SERVER_MEMBER_JOIN"
	EventMemberKick       = "MEMBER_KICK"
	EventMemberBan        = "MEMBER_BAN"
	EventNotification     = "NOTIFICATION"
	EventReactionAdd      = "REACTION_ADD"
	EventReactionRemove   = "REACTION_REMOVE"
	EventDMCreate              = "DM_CREATE"
	EventMemberTimeout         = "MEMBER_TIMEOUT"
	EventServerMemberLeave     = "SERVER_MEMBER_LEAVE"
	EventServerDelete          = "SERVER_DELETE"
	EventMessagePin            = "MESSAGE_PIN"
	EventMessageUnpin          = "MESSAGE_UNPIN"
	EventMemberNicknameUpdate  = "MEMBER_NICKNAME_UPDATE"
)

type Event struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}
