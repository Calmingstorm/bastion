package models

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

type User struct {
	ID           uuid.UUID  `json:"id"`
	Username     string     `json:"username"`
	Email        string     `json:"email"`
	PasswordHash string     `json:"-"`
	DisplayName  *string    `json:"displayName,omitempty"`
	AvatarURL    *string    `json:"avatarUrl,omitempty"`
	Status       string     `json:"status"`
	AboutMe      *string    `json:"aboutMe,omitempty"`
	CreatedAt    time.Time  `json:"createdAt"`
	UpdatedAt    time.Time  `json:"updatedAt"`
}

type Server struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	IconURL     *string   `json:"iconUrl,omitempty"`
	Description *string   `json:"description,omitempty"`
	OwnerID     uuid.UUID `json:"ownerId"`
	CreatedAt   time.Time `json:"createdAt"`
}

type Channel struct {
	ID         uuid.UUID  `json:"id"`
	ServerID   *uuid.UUID `json:"serverId,omitempty"`
	Name       string     `json:"name"`
	Topic      *string    `json:"topic,omitempty"`
	Type       string     `json:"type"`
	Position   int        `json:"position"`
	CategoryID *uuid.UUID `json:"categoryId,omitempty"`
	CreatedAt  time.Time  `json:"createdAt"`
}

type Message struct {
	ID          uuid.UUID    `json:"id"`
	ChannelID   uuid.UUID    `json:"channelId"`
	AuthorID    uuid.UUID    `json:"-"`
	Author      *Author      `json:"author"`
	Content     string       `json:"content"`
	EditedAt    *time.Time   `json:"editedAt,omitempty"`
	ReplyToID   *uuid.UUID   `json:"replyToId,omitempty"`
	ReplyTo     *ReplyInfo   `json:"replyTo,omitempty"`
	Attachments []Attachment `json:"attachments,omitempty"`
	Reactions   []Reaction   `json:"reactions,omitempty"`
	CreatedAt   time.Time    `json:"createdAt"`
}

type ReplyInfo struct {
	ID      uuid.UUID `json:"id"`
	Content string    `json:"content"`
	Author  Author    `json:"author"`
}

type Reaction struct {
	Emoji string   `json:"emoji"`
	Count int      `json:"count"`
	Users []string `json:"users"`
}

type Author struct {
	ID          uuid.UUID `json:"id"`
	Username    string    `json:"username"`
	DisplayName *string   `json:"displayName,omitempty"`
	AvatarURL   *string   `json:"avatarUrl,omitempty"`
}

type ServerMember struct {
	ServerID      uuid.UUID  `json:"serverId"`
	UserID        uuid.UUID  `json:"userId"`
	Nickname      *string    `json:"nickname,omitempty"`
	Role          string     `json:"role"`
	TimedOutUntil *time.Time `json:"timedOutUntil,omitempty"`
	JoinedAt      time.Time  `json:"joinedAt"`
}

type ServerInvite struct {
	ID        uuid.UUID  `json:"id"`
	ServerID  uuid.UUID  `json:"serverId"`
	CreatorID uuid.UUID  `json:"creatorId"`
	Code      string     `json:"code"`
	MaxUses   *int       `json:"maxUses,omitempty"`
	Uses      int        `json:"uses"`
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
}

type Attachment struct {
	ID          uuid.UUID `json:"id"`
	MessageID   uuid.UUID `json:"messageId"`
	Filename    string    `json:"filename"`
	StoredName  string    `json:"storedName"`
	ContentType string    `json:"contentType"`
	Size        int64     `json:"size"`
	URL         string    `json:"url"`
	CreatedAt   time.Time `json:"createdAt"`
}

type DMChannel struct {
	Channel
	Recipients []Author `json:"recipients,omitempty"`
	LastMessage *Message `json:"lastMessage,omitempty"`
}

type ReadState struct {
	UserID        uuid.UUID  `json:"userId"`
	ChannelID     uuid.UUID  `json:"channelId"`
	LastMessageID *uuid.UUID `json:"lastMessageId,omitempty"`
	LastReadAt    time.Time  `json:"lastReadAt"`
	MentionCount  int        `json:"mentionCount"`
}

type MemberWithUser struct {
	ServerID      uuid.UUID  `json:"serverId"`
	UserID        uuid.UUID  `json:"userId"`
	Username      string     `json:"username"`
	DisplayName   *string    `json:"displayName,omitempty"`
	AvatarURL     *string    `json:"avatarUrl,omitempty"`
	Nickname      *string    `json:"nickname,omitempty"`
	Role          string     `json:"role"`
	Status        string     `json:"status"`
	TimedOutUntil *time.Time `json:"timedOutUntil,omitempty"`
	JoinedAt      time.Time  `json:"joinedAt"`
	Roles         []RoleInfo `json:"roles,omitempty"`
}

// Phase 3: Permissions & Server Management

type Role struct {
	ID          uuid.UUID `json:"id"`
	ServerID    uuid.UUID `json:"serverId"`
	Name        string    `json:"name"`
	Color       *string   `json:"color,omitempty"`
	Position    int       `json:"position"`
	Permissions int64     `json:"permissions"`
	IsDefault   bool      `json:"isDefault"`
	CreatedAt   time.Time `json:"createdAt"`
}

// RoleInfo is a compact role representation for embedding in member lists.
type RoleInfo struct {
	ID       uuid.UUID `json:"id"`
	Name     string    `json:"name"`
	Color    *string   `json:"color,omitempty"`
	Position int       `json:"position"`
}

type ChannelCategory struct {
	ID        uuid.UUID `json:"id"`
	ServerID  uuid.UUID `json:"serverId"`
	Name      string    `json:"name"`
	Position  int       `json:"position"`
	CreatedAt time.Time `json:"createdAt"`
}

type ChannelPermissionOverride struct {
	ID         uuid.UUID `json:"id"`
	ChannelID  uuid.UUID `json:"channelId"`
	TargetType string    `json:"targetType"`
	TargetID   uuid.UUID `json:"targetId"`
	Allow      int64     `json:"allow"`
	Deny       int64     `json:"deny"`
}

type ServerBan struct {
	ServerID  uuid.UUID `json:"serverId"`
	UserID    uuid.UUID `json:"userId"`
	Username  string    `json:"username,omitempty"`
	Reason    *string   `json:"reason,omitempty"`
	BannedBy  uuid.UUID `json:"bannedBy"`
	CreatedAt time.Time `json:"createdAt"`
}

type AuditLogEntry struct {
	ID         uuid.UUID       `json:"id"`
	ServerID   uuid.UUID       `json:"serverId"`
	ActorID    uuid.UUID       `json:"actorId"`
	Actor      *Author         `json:"actor,omitempty"`
	ActionType string          `json:"actionType"`
	TargetType *string         `json:"targetType,omitempty"`
	TargetID   *uuid.UUID      `json:"targetId,omitempty"`
	Changes    json.RawMessage `json:"changes,omitempty"`
	Reason     *string         `json:"reason,omitempty"`
	CreatedAt  time.Time       `json:"createdAt"`
}

// Audit log action types
const (
	AuditRoleCreate       = "ROLE_CREATE"
	AuditRoleUpdate       = "ROLE_UPDATE"
	AuditRoleDelete       = "ROLE_DELETE"
	AuditChannelCreate    = "CHANNEL_CREATE"
	AuditChannelUpdate    = "CHANNEL_UPDATE"
	AuditChannelDelete    = "CHANNEL_DELETE"
	AuditCategoryCreate   = "CATEGORY_CREATE"
	AuditCategoryUpdate   = "CATEGORY_UPDATE"
	AuditCategoryDelete   = "CATEGORY_DELETE"
	AuditMemberKick       = "MEMBER_KICK"
	AuditMemberBan        = "MEMBER_BAN"
	AuditMemberUnban      = "MEMBER_UNBAN"
	AuditMemberTimeout    = "MEMBER_TIMEOUT"
	AuditMemberRoleUpdate = "MEMBER_ROLE_UPDATE"
	AuditServerUpdate     = "SERVER_UPDATE"
	AuditInviteCreate     = "INVITE_CREATE"
	AuditInviteDelete     = "INVITE_DELETE"
	AuditMessageDelete    = "MESSAGE_DELETE"
)
