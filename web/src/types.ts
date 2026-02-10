export interface User {
  id: string;
  username: string;
  email: string;
  displayName?: string;
  avatarUrl?: string;
  status: string;
  aboutMe?: string;
  createdAt?: string;
}

export interface Server {
  id: string;
  name: string;
  iconUrl?: string;
  description?: string;
  ownerId: string;
  memberCount?: number;
  createdAt: string;
}

export interface Channel {
  id: string;
  serverId?: string;
  name: string;
  topic?: string;
  type: string;
  position: number;
  categoryId?: string;
}

export interface MessageAuthor {
  id: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface Attachment {
  id: string;
  messageId: string;
  filename: string;
  storedName: string;
  contentType: string;
  size: number;
  url: string;
  createdAt: string;
}

export interface Message {
  id: string;
  channelId: string;
  author: MessageAuthor;
  content: string;
  createdAt: string;
  editedAt?: string;
  replyToId?: string;
  replyTo?: { id: string; content: string; author: MessageAuthor };
  attachments?: Attachment[];
  reactions?: Reaction[];
}

export interface Reaction {
  emoji: string;
  count: number;
  users: string[];
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
}

export interface RegisterResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
}

export interface ApiError {
  error: string;
  message: string;
}

export interface ServerInvite {
  id: string;
  serverId: string;
  creatorId: string;
  code: string;
  maxUses?: number;
  uses: number;
  expiresAt?: string;
  createdAt: string;
}

export interface DMChannel {
  id: string;
  serverId?: string;
  name: string;
  topic?: string;
  type: string;
  position: number;
  createdAt: string;
  recipients: MessageAuthor[];
  lastMessage?: Message;
}

export interface ReadState {
  userId: string;
  channelId: string;
  lastMessageId?: string;
  lastReadAt: string;
  mentionCount: number;
}

export interface MemberWithUser {
  serverId: string;
  userId: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  nickname?: string;
  role: string;
  status: string;
  timedOutUntil?: string;
  joinedAt: string;
  roles?: RoleInfo[];
}

export interface RoleInfo {
  id: string;
  name: string;
  color?: string;
  position: number;
}

export interface Role {
  id: string;
  serverId: string;
  name: string;
  color?: string;
  position: number;
  permissions: number;
  isDefault: boolean;
  createdAt: string;
}

export interface ChannelCategory {
  id: string;
  serverId: string;
  name: string;
  position: number;
  createdAt: string;
}

export interface ServerBan {
  serverId: string;
  userId: string;
  username: string;
  reason?: string;
  bannedBy: string;
  createdAt: string;
}

export interface AuditLogEntry {
  id: string;
  serverId: string;
  actorId: string;
  actor?: MessageAuthor;
  actionType: string;
  targetType?: string;
  targetId?: string;
  changes?: Record<string, unknown>;
  reason?: string;
  createdAt: string;
}

export interface SearchResult {
  id: string;
  channelId: string;
  content: string;
  createdAt: string;
  authorId: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  channelName: string;
  serverName?: string;
}

export type WSEventType =
  | 'MESSAGE_CREATE'
  | 'MESSAGE_UPDATE'
  | 'MESSAGE_DELETE'
  | 'CHANNEL_CREATE'
  | 'CHANNEL_UPDATE'
  | 'CHANNEL_DELETE'
  | 'SERVER_UPDATE'
  | 'MEMBER_JOIN'
  | 'MEMBER_LEAVE'
  | 'MEMBER_KICK'
  | 'MEMBER_BAN'
  | 'MEMBER_TIMEOUT'
  | 'PRESENCE_UPDATE'
  | 'TYPING_START'
  | 'SERVER_MEMBER_JOIN'
  | 'NOTIFICATION'
  | 'REACTION_ADD'
  | 'REACTION_REMOVE'
  | 'DM_CREATE'
  | 'SERVER_MEMBER_LEAVE'
  | 'SERVER_DELETE'
  | 'MESSAGE_PIN'
  | 'MESSAGE_UNPIN'
  | 'MEMBER_NICKNAME_UPDATE';

export interface PinnedMessage {
  id: string;
  channelId: string;
  content: string;
  editedAt?: string;
  createdAt: string;
  author: MessageAuthor;
  pinnedAt: string;
}

export interface WSMessage {
  type: WSEventType;
  data: unknown;
}

export interface WSMessageCreateData {
  message: Message;
}
