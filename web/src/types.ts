export interface User {
  id: string;
  username: string;
  email: string;
  displayName?: string;
  avatarUrl?: string;
  status: string;
  aboutMe?: string;
}

export interface Server {
  id: string;
  name: string;
  iconUrl?: string;
  ownerId: string;
  createdAt: string;
}

export interface Channel {
  id: string;
  serverId?: string;
  name: string;
  topic?: string;
  type: string;
  position: number;
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
  attachments?: Attachment[];
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
  joinedAt: string;
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
  | 'PRESENCE_UPDATE'
  | 'TYPING_START'
  | 'SERVER_MEMBER_JOIN'
  | 'NOTIFICATION';

export interface WSMessage {
  type: WSEventType;
  data: unknown;
}

export interface WSMessageCreateData {
  message: Message;
}
