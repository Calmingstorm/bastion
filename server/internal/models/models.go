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
	ID        uuid.UUID `json:"id"`
	ServerID  uuid.UUID `json:"serverId"`
	Name      string    `json:"name"`
	Topic     *string   `json:"topic,omitempty"`
	Position  int       `json:"position"`
	CreatedAt time.Time `json:"createdAt"`
}

type Message struct {
	ID        uuid.UUID  `json:"id"`
	ChannelID uuid.UUID  `json:"channelId"`
	AuthorID  uuid.UUID  `json:"-"`
	Author    *Author    `json:"author"`
	Content   string     `json:"content"`
	EditedAt  *time.Time `json:"editedAt,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
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
	JoinedAt time.Time  `json:"joinedAt"`
}
