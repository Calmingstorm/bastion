# Bastion WebSocket Protocol

## Connection

```
GET /api/v1/ws?token={JWT_ACCESS_TOKEN}
```

Upgrade to WebSocket connection. The JWT access token is passed as a query parameter and validated during the HTTP upgrade handshake.

### Authentication

- Token: JWT access token (same as used for REST API `Authorization: Bearer` header)
- Token lifetime: 15 minutes
- On token expiry: Client should read fresh token from storage before reconnecting (tokens are refreshed by the REST client's 401 interceptor)

### Reconnection

- Strategy: Exponential backoff starting at 1s, doubling each attempt, capped at 30s
- On reconnect: Client reads fresh access token from localStorage before rebuilding the WebSocket URL
- After reconnect: Client refetches active channel messages, member list, DMs, and unread states to recover events missed during the disconnect window

## Heartbeat / Keep-Alive

| Direction | Message | Interval | Purpose |
|-----------|---------|----------|---------|
| Server -> Client | WebSocket ping frame | Every 30s | Detect dead connections |
| Client -> Server | `{ "type": "HEARTBEAT" }` | Every 60s | Refresh presence TTL |

- Presence TTL in Redis: 90 seconds
- If no HEARTBEAT received within 90s, user's presence key expires and they appear offline

## Subscription Model

- **On connect:** Server automatically subscribes the client to all channels the user has access to (server channels via `server_members` + DM channels via `dm_members`)
- **On server join:** Server subscribes the user's WebSocket clients to all channels in the joined server
- **On server leave:** Server unsubscribes the user's WebSocket clients from all channels in the left server
- **On disconnect:** Server unsubscribes the client from all channels and removes from user mapping

## Client -> Server Messages

### HEARTBEAT
```json
{ "type": "HEARTBEAT" }
```
Refreshes the user's presence TTL in Redis.

### PRESENCE_UPDATE
```json
{ "type": "PRESENCE_UPDATE", "data": { "status": "online" | "idle" | "dnd" | "offline" } }
```
Sets the user's presence status. Broadcast to all subscribed channels.

### TYPING_START
```json
{ "type": "TYPING_START", "data": { "channelId": "uuid" } }
```
Indicates the user is typing in a channel. Debounced server-side (8s Redis key per user/channel pair).

## Server -> Client Events

All events follow this format:
```json
{ "type": "EVENT_TYPE", "data": { ... } }
```

### Message Events

#### MESSAGE_CREATE
```typescript
{ message: Message }
// or flat Message object
```
A new message was sent in a channel.

#### MESSAGE_UPDATE
```typescript
{ message: Message }
// or flat Message object
```
A message was edited.

#### MESSAGE_DELETE
```typescript
{ channelId: string; messageId: string }
```

### Channel Events

#### CHANNEL_CREATE
```typescript
{ channel: Channel }
// or flat Channel object
```

#### CHANNEL_UPDATE
```typescript
{ channel: Channel }
// or flat Channel object
```

#### CHANNEL_DELETE
```typescript
{ channelId: string; serverId: string }
```

### Server Events

#### SERVER_UPDATE
```typescript
Server  // { id, name, iconUrl?, description?, ownerId, createdAt }
```
Server name, description, or icon was changed.

#### SERVER_DELETE
```typescript
{ serverId: string }
```

### Member Events

#### SERVER_MEMBER_JOIN
```typescript
{ serverId: string; userId: string }
```

#### SERVER_MEMBER_LEAVE
```typescript
{ serverId: string; userId: string }
```

#### MEMBER_KICK
```typescript
{ serverId: string; userId: string }
```

#### MEMBER_BAN
```typescript
{ serverId: string; userId: string }
```

#### MEMBER_TIMEOUT
```typescript
{ serverId: string; userId: string; timedOutUntil: string }
```

#### MEMBER_NICKNAME_UPDATE
```typescript
{ serverId: string; userId: string; nickname: string }
```

### Role Events

#### ROLE_CREATE
```typescript
Role  // { id, serverId, name, color?, position, permissions, isDefault, createdAt }
```

#### ROLE_UPDATE
```typescript
Role
```

#### ROLE_DELETE
```typescript
{ roleId: string; serverId: string }
```

#### ROLE_ASSIGNED
```typescript
{ serverId: string; roleId: string; userId: string }
```

#### ROLE_REMOVED
```typescript
{ serverId: string; roleId: string; userId: string }
```

### Category Events

#### CATEGORY_CREATE
```typescript
ChannelCategory  // { id, serverId, name, position, createdAt }
```

#### CATEGORY_UPDATE
```typescript
ChannelCategory
```

#### CATEGORY_DELETE
```typescript
{ categoryId: string; serverId: string }
```

### Presence Events

#### PRESENCE_UPDATE
```typescript
{ userId: string; status: string }
```

### Typing Events

#### TYPING_START
```typescript
{ channelId: string; userId: string }
```

### Notification Events

#### NOTIFICATION
```typescript
{ channelId: string; mentionCount?: number; senderName?: string; channelName?: string; content?: string }
```

### Reaction Events

#### REACTION_ADD
```typescript
{ channelId: string; messageId: string; userId: string; emoji: string }
```

#### REACTION_REMOVE
```typescript
{ channelId: string; messageId: string; userId: string; emoji: string }
```

### DM Events

#### DM_CREATE
```typescript
DMChannel  // { id, name, type, position, createdAt, recipients, lastMessage? }
```

### Pin Events

#### MESSAGE_PIN
```typescript
{ channelId: string; messageId: string }
```

#### MESSAGE_UNPIN
```typescript
{ channelId: string; messageId: string }
```

### Internal Events (Client-Only)

#### CONNECTED
```typescript
{ isReconnect: boolean }
```
Emitted locally by the WebSocket client when the connection opens. Not sent over the wire. `isReconnect` is `true` for all connections after the first successful one.

## Error Handling

- **Send buffer overflow:** Server buffers up to 256 events per client. If the buffer fills, events are dropped with a warning log. After 10 consecutive drops, the server closes the connection with status `4013 (Try Again Later)`. The client will reconnect and get fresh state.
- **Malformed messages:** Silently ignored (logged client-side).
- **Connection errors:** Trigger automatic reconnection with exponential backoff.
