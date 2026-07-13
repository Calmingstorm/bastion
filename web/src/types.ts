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
  isBot?: boolean;
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

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface EmbedFooter {
  text: string;
}

export interface EmbedImage {
  url: string;
}

export interface Embed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: EmbedField[];
  footer?: EmbedFooter;
  thumbnail?: EmbedImage;
  image?: EmbedImage;
}

export interface AuthorOverride {
  username: string;
  avatarUrl?: string;
}

export interface Message {
  id: string;
  channelId: string;
  author: MessageAuthor;
  content: string;
  embeds?: Embed[];
  authorOverride?: AuthorOverride;
  createdAt: string;
  editedAt?: string;
  replyToId?: string;
  replyTo?: { id: string; content: string; author: MessageAuthor };
  attachments?: Attachment[];
  reactions?: Reaction[];
  ephemeral?: boolean;
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
  isBot?: boolean;
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

export interface Webhook {
  id: string;
  serverId: string;
  channelId: string;
  creatorId: string;
  name: string;
  avatarUrl?: string;
  /** Plaintext token — present ONLY in the create/regenerate response. */
  token?: string;
  /** Last 8 characters of the token, safe to display on list/get. */
  tokenHint?: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Bot {
  id: string;
  serverId: string;
  creatorId: string;
  userId: string;
  username: string;
  avatarUrl?: string;
  description?: string;
  tokenHint: string;
  token?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommandOption {
  name: string;
  description: string;
  type: number;
  required?: boolean;
  choices?: { name: string; value: string }[];
}

export interface ApplicationCommand {
  id: string;
  serverId: string;
  botId: string;
  type: number; // 1=CHAT_INPUT, 2=USER, 3=MESSAGE
  name: string;
  description: string;
  options?: CommandOption[];
  createdAt: string;
  updatedAt: string;
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
  | 'MEMBER_NICKNAME_UPDATE'
  | 'ROLE_CREATE'
  | 'ROLE_UPDATE'
  | 'ROLE_DELETE'
  | 'ROLE_ASSIGNED'
  | 'ROLE_REMOVED'
  | 'SERVER_UPDATE'
  | 'CATEGORY_CREATE'
  | 'CATEGORY_UPDATE'
  | 'CATEGORY_DELETE'
  | 'INTERACTION_CREATE'
  | 'CONNECTED';

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
