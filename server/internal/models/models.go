package models

import (
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
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	IconURL   *string   `json:"iconUrl,omitempty"`
	OwnerID   uuid.UUID `json:"ownerId"`
	CreatedAt time.Time `json:"createdAt"`
}

type Channel struct {
	ID        uuid.UUID  `json:"id"`
	ServerID  *uuid.UUID `json:"serverId,omitempty"`
	Name      string     `json:"name"`
	Topic     *string    `json:"topic,omitempty"`
	Type      string     `json:"type"`
	Position  int        `json:"position"`
	CreatedAt time.Time  `json:"createdAt"`
}

type Message struct {
	ID          uuid.UUID    `json:"id"`
	ChannelID   uuid.UUID    `json:"channelId"`
	AuthorID    uuid.UUID    `json:"-"`
	Author      *Author      `json:"author"`
	Content     string       `json:"content"`
	EditedAt    *time.Time   `json:"editedAt,omitempty"`
	Attachments []Attachment `json:"attachments,omitempty"`
	CreatedAt   time.Time    `json:"createdAt"`
}

type Author struct {
	ID          uuid.UUID `json:"id"`
	Username    string    `json:"username"`
	DisplayName *string   `json:"displayName,omitempty"`
	AvatarURL   *string   `json:"avatarUrl,omitempty"`
}

type ServerMember struct {
	ServerID uuid.UUID  `json:"serverId"`
	UserID   uuid.UUID  `json:"userId"`
	Nickname *string    `json:"nickname,omitempty"`
	Role     string     `json:"role"`
	JoinedAt time.Time  `json:"joinedAt"`
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
	ServerID    uuid.UUID `json:"serverId"`
	UserID      uuid.UUID `json:"userId"`
	Username    string    `json:"username"`
	DisplayName *string   `json:"displayName,omitempty"`
	AvatarURL   *string   `json:"avatarUrl,omitempty"`
	Nickname    *string   `json:"nickname,omitempty"`
	Role        string    `json:"role"`
	Status      string    `json:"status"`
	JoinedAt    time.Time `json:"joinedAt"`
}
