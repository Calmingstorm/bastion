import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import type {
  User,
  Server,
  Channel,
  Message,
  LoginResponse,
  RegisterResponse,
  ServerInvite,
  DMChannel,
  ReadState,
  MemberWithUser,
  Role,
  ChannelCategory,
  ServerBan,
  AuditLogEntry,
} from '../types';

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '',
  headers: {
    'Content-Type': 'application/json',
  },
});

function getAccessToken(): string | null {
  return localStorage.getItem('accessToken');
}

function getRefreshToken(): string | null {
  return localStorage.getItem('refreshToken');
}

function setTokens(accessToken: string, refreshToken: string): void {
  localStorage.setItem('accessToken', accessToken);
  localStorage.setItem('refreshToken', refreshToken);
}

function clearTokens(): void {
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
  localStorage.removeItem('user');
}

// Request interceptor: attach Bearer token
apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = getAccessToken();
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor: handle 401 with token refresh
let isRefreshing = false;
let failedQueue: Array<{
  resolve: (token: string) => void;
  reject: (error: unknown) => void;
}> = [];

function processQueue(error: unknown, token: string | null = null): void {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else if (token) {
      prom.resolve(token);
    }
  });
  failedQueue = [];
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config;
    if (!originalRequest) {
      return Promise.reject(error);
    }

    // If 401 and not already retrying
    if (
      error.response?.status === 401 &&
      !(originalRequest as InternalAxiosRequestConfig & { _retry?: boolean })._retry
    ) {
      if (isRefreshing) {
        return new Promise<string>((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then((token) => {
          if (originalRequest.headers) {
            originalRequest.headers.Authorization = `Bearer ${token}`;
          }
          return apiClient(originalRequest);
        });
      }

      (originalRequest as InternalAxiosRequestConfig & { _retry?: boolean })._retry = true;
      isRefreshing = true;

      const refreshToken = getRefreshToken();
      if (!refreshToken) {
        clearTokens();
        window.location.href = '/login';
        return Promise.reject(error);
      }

      try {
        const response = await axios.post<{ accessToken: string }>(
          `${import.meta.env.VITE_API_URL || ''}/api/auth/refresh`,
          { refreshToken }
        );
        const { accessToken } = response.data;
        setTokens(accessToken, refreshToken);
        processQueue(null, accessToken);

        if (originalRequest.headers) {
          originalRequest.headers.Authorization = `Bearer ${accessToken}`;
        }
        return apiClient(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError, null);
        clearTokens();
        window.location.href = '/login';
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

// ---- Auth API ----

export async function apiLogin(
  email: string,
  password: string
): Promise<LoginResponse> {
  const response = await apiClient.post<LoginResponse>('/api/auth/login', {
    email,
    password,
  });
  return response.data;
}

export async function apiRegister(
  username: string,
  email: string,
  password: string
): Promise<RegisterResponse> {
  const response = await apiClient.post<RegisterResponse>('/api/auth/register', {
    username,
    email,
    password,
  });
  return response.data;
}

export async function apiRefreshToken(
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string }> {
  const response = await apiClient.post<{
    accessToken: string;
    refreshToken: string;
  }>('/api/auth/refresh', { refreshToken });
  return response.data;
}

export async function apiGetMe(): Promise<User> {
  const response = await apiClient.get<User>('/api/users/me');
  return response.data;
}

// ---- User API ----

export async function apiUpdateProfile(data: {
  displayName?: string;
  aboutMe?: string;
  status?: string;
}): Promise<User> {
  const response = await apiClient.patch<User>('/api/users/me', data);
  return response.data;
}

export async function apiUploadAvatar(file: File): Promise<User> {
  const formData = new FormData();
  formData.append('avatar', file);
  const response = await apiClient.post<User>('/api/users/me/avatar', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return response.data;
}

export async function apiGetUser(userId: string): Promise<User> {
  const response = await apiClient.get<User>(`/api/users/${userId}`);
  return response.data;
}

// ---- Server API ----

export async function apiGetServers(): Promise<Server[]> {
  const response = await apiClient.get<Server[]>('/api/servers');
  return response.data;
}

export async function apiCreateServer(name: string): Promise<Server> {
  const response = await apiClient.post<Server>('/api/servers', { name });
  return response.data;
}

export async function apiJoinServer(inviteCode: string): Promise<Server> {
  const response = await apiClient.post<Server>(`/api/invites/${inviteCode}/join`);
  return response.data;
}

// ---- Channel API ----

export async function apiGetChannels(serverId: string): Promise<Channel[]> {
  const response = await apiClient.get<Channel[]>(
    `/api/servers/${serverId}/channels`
  );
  return response.data;
}

export async function apiCreateChannel(
  serverId: string,
  name: string,
  topic?: string
): Promise<Channel> {
  const response = await apiClient.post<Channel>(
    `/api/servers/${serverId}/channels`,
    { name, topic }
  );
  return response.data;
}

export async function apiUpdateChannel(
  serverId: string,
  channelId: string,
  data: { name?: string; topic?: string }
): Promise<Channel> {
  const response = await apiClient.patch<Channel>(
    `/api/servers/${serverId}/channels/${channelId}`,
    data
  );
  return response.data;
}

export async function apiDeleteChannel(
  serverId: string,
  channelId: string
): Promise<void> {
  await apiClient.delete(`/api/servers/${serverId}/channels/${channelId}`);
}

// ---- Message API ----

export async function apiGetMessages(
  channelId: string,
  before?: string,
  limit: number = 50
): Promise<Message[]> {
  const params: Record<string, string | number> = { limit };
  if (before) {
    params.before = before;
  }
  const response = await apiClient.get<Message[]>(
    `/api/channels/${channelId}/messages`,
    { params }
  );
  return response.data;
}

export async function apiSendMessage(
  channelId: string,
  content: string,
  replyToId?: string
): Promise<Message> {
  const body: Record<string, string> = { content };
  if (replyToId) body.replyToId = replyToId;
  const response = await apiClient.post<Message>(
    `/api/channels/${channelId}/messages`,
    body
  );
  return response.data;
}

export async function apiEditMessage(
  channelId: string,
  messageId: string,
  content: string
): Promise<Message> {
  const response = await apiClient.put<Message>(
    `/api/channels/${channelId}/messages/${messageId}`,
    { content }
  );
  return response.data;
}

export async function apiDeleteMessage(
  channelId: string,
  messageId: string
): Promise<void> {
  await apiClient.delete(`/api/channels/${channelId}/messages/${messageId}`);
}

export async function apiSendMessageWithFiles(
  channelId: string,
  content: string,
  files: File[]
): Promise<Message> {
  const formData = new FormData();
  formData.append('content', content);
  files.forEach((file) => formData.append('files', file));
  const response = await apiClient.post<Message>(
    `/api/channels/${channelId}/messages/upload`,
    formData,
    { headers: { 'Content-Type': 'multipart/form-data' } }
  );
  return response.data;
}

// ---- Invite API ----

export async function apiCreateInvite(
  serverId: string,
  options?: { maxUses?: number; expiresIn?: number }
): Promise<ServerInvite> {
  const response = await apiClient.post<ServerInvite>(
    `/api/servers/${serverId}/invites`,
    options || {}
  );
  return response.data;
}

export async function apiGetInvites(serverId: string): Promise<ServerInvite[]> {
  const response = await apiClient.get<ServerInvite[]>(
    `/api/servers/${serverId}/invites`
  );
  return response.data;
}

export async function apiDeleteInvite(inviteId: string): Promise<void> {
  await apiClient.delete(`/api/invites/${inviteId}`);
}

export async function apiJoinViaInvite(code: string): Promise<Server> {
  const response = await apiClient.post<Server>(`/api/invites/${code}/join`);
  return response.data;
}

// ---- DM API ----

export async function apiCreateDM(recipientIds: string[]): Promise<DMChannel> {
  const response = await apiClient.post<DMChannel>('/api/dm', { recipientIds });
  return response.data;
}

export async function apiGetDMs(): Promise<DMChannel[]> {
  const response = await apiClient.get<DMChannel[]>('/api/dm');
  return response.data;
}

export async function apiGetDM(channelId: string): Promise<DMChannel> {
  const response = await apiClient.get<DMChannel>(`/api/dm/${channelId}`);
  return response.data;
}

// ---- Read State API ----

export async function apiAckChannel(
  channelId: string,
  messageId: string
): Promise<void> {
  await apiClient.post(`/api/channels/${channelId}/ack`, { messageId });
}

export async function apiGetReadStates(): Promise<ReadState[]> {
  const response = await apiClient.get<ReadState[]>('/api/users/me/read-states');
  return response.data;
}

// ---- Members API ----

export async function apiGetMembers(serverId: string): Promise<MemberWithUser[]> {
  const response = await apiClient.get<MemberWithUser[]>(
    `/api/servers/${serverId}/members`
  );
  return response.data;
}

// ---- Password Reset API ----

export async function apiForgotPassword(
  email: string
): Promise<{ message: string }> {
  const response = await apiClient.post<{ message: string }>(
    '/api/auth/forgot-password',
    { email }
  );
  return response.data;
}

export async function apiResetPassword(
  token: string,
  password: string
): Promise<{ message: string }> {
  const response = await apiClient.post<{ message: string }>(
    '/api/auth/reset-password',
    { token, password }
  );
  return response.data;
}

// ---- Server Settings API ----

export async function apiUpdateServer(
  serverId: string,
  data: { name?: string; description?: string }
): Promise<Server> {
  const response = await apiClient.patch<Server>(`/api/servers/${serverId}`, data);
  return response.data;
}

export async function apiUploadServerIcon(serverId: string, file: File): Promise<Server> {
  const formData = new FormData();
  formData.append('icon', file);
  const response = await apiClient.post<Server>(`/api/servers/${serverId}/icon`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return response.data;
}

// ---- Roles API ----

export async function apiGetRoles(serverId: string): Promise<Role[]> {
  const response = await apiClient.get<Role[]>(`/api/servers/${serverId}/roles`);
  return response.data;
}

export async function apiCreateRole(
  serverId: string,
  data: { name: string; color?: string; permissions?: number }
): Promise<Role> {
  const response = await apiClient.post<Role>(`/api/servers/${serverId}/roles`, data);
  return response.data;
}

export async function apiUpdateRole(
  serverId: string,
  roleId: string,
  data: { name?: string; color?: string; permissions?: number }
): Promise<Role> {
  const response = await apiClient.patch<Role>(
    `/api/servers/${serverId}/roles/${roleId}`,
    data
  );
  return response.data;
}

export async function apiDeleteRole(serverId: string, roleId: string): Promise<void> {
  await apiClient.delete(`/api/servers/${serverId}/roles/${roleId}`);
}

export async function apiAssignRole(
  serverId: string,
  roleId: string,
  userId: string
): Promise<void> {
  await apiClient.post(`/api/servers/${serverId}/roles/${roleId}/assign`, { userId });
}

export async function apiRemoveRole(
  serverId: string,
  roleId: string,
  userId: string
): Promise<void> {
  await apiClient.post(`/api/servers/${serverId}/roles/${roleId}/remove`, { userId });
}

export async function apiGetMemberPermissions(
  serverId: string
): Promise<{ permissions: number }> {
  const response = await apiClient.get<{ permissions: number }>(
    `/api/servers/${serverId}/permissions`
  );
  return response.data;
}

// ---- Categories API ----

export async function apiGetCategories(serverId: string): Promise<ChannelCategory[]> {
  const response = await apiClient.get<ChannelCategory[]>(
    `/api/servers/${serverId}/categories`
  );
  return response.data;
}

export async function apiCreateCategory(
  serverId: string,
  name: string
): Promise<ChannelCategory> {
  const response = await apiClient.post<ChannelCategory>(
    `/api/servers/${serverId}/categories`,
    { name }
  );
  return response.data;
}

export async function apiUpdateCategory(
  serverId: string,
  categoryId: string,
  data: { name?: string; position?: number }
): Promise<ChannelCategory> {
  const response = await apiClient.patch<ChannelCategory>(
    `/api/servers/${serverId}/categories/${categoryId}`,
    data
  );
  return response.data;
}

export async function apiDeleteCategory(
  serverId: string,
  categoryId: string
): Promise<void> {
  await apiClient.delete(`/api/servers/${serverId}/categories/${categoryId}`);
}

// ---- Moderation API ----

export async function apiKickMember(
  serverId: string,
  userId: string,
  reason?: string
): Promise<void> {
  await apiClient.post(`/api/servers/${serverId}/kick/${userId}`, { reason });
}

export async function apiBanMember(
  serverId: string,
  userId: string,
  reason?: string
): Promise<void> {
  await apiClient.post(`/api/servers/${serverId}/bans/${userId}`, { reason });
}

export async function apiUnbanMember(
  serverId: string,
  userId: string
): Promise<void> {
  await apiClient.delete(`/api/servers/${serverId}/bans/${userId}`);
}

export async function apiGetBans(serverId: string): Promise<ServerBan[]> {
  const response = await apiClient.get<ServerBan[]>(`/api/servers/${serverId}/bans`);
  return response.data;
}

export async function apiTimeoutMember(
  serverId: string,
  userId: string,
  duration: number,
  reason?: string
): Promise<void> {
  await apiClient.post(`/api/servers/${serverId}/timeout/${userId}`, {
    duration,
    reason,
  });
}

// ---- Audit Log API ----

export async function apiGetAuditLog(
  serverId: string,
  filters?: { action?: string; actor?: string }
): Promise<AuditLogEntry[]> {
  const params: Record<string, string> = {};
  if (filters?.action) params.action = filters.action;
  if (filters?.actor) params.actor = filters.actor;
  const response = await apiClient.get<AuditLogEntry[]>(
    `/api/servers/${serverId}/audit-log`,
    { params }
  );
  return response.data;
}

// ---- Reactions API ----

export async function apiAddReaction(
  channelId: string,
  messageId: string,
  emoji: string
): Promise<void> {
  await apiClient.put(`/api/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
}

export async function apiRemoveReaction(
  channelId: string,
  messageId: string,
  emoji: string
): Promise<void> {
  await apiClient.delete(`/api/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
}

// ---- Search API ----

import type { SearchResult } from '../types';

export async function apiSearch(
  query: string,
  options?: { serverId?: string; channelId?: string; limit?: number; offset?: number }
): Promise<SearchResult[]> {
  const params: Record<string, string | number> = { q: query };
  if (options?.serverId) params.serverId = options.serverId;
  if (options?.channelId) params.channelId = options.channelId;
  if (options?.limit) params.limit = options.limit;
  if (options?.offset) params.offset = options.offset;
  const response = await apiClient.get<SearchResult[]>('/api/search', { params });
  return response.data;
}

// ---- GIF API ----

export interface GifResult {
  id: string;
  title: string;
  previewUrl: string;
  url: string;
  width: number;
  height: number;
}

export async function apiSearchGifs(query: string, limit = 20): Promise<GifResult[]> {
  const response = await apiClient.get<GifResult[]>('/api/gifs/search', {
    params: { q: query, limit },
  });
  return response.data;
}

export async function apiTrendingGifs(limit = 20): Promise<GifResult[]> {
  const response = await apiClient.get<GifResult[]>('/api/gifs/trending', {
    params: { limit },
  });
  return response.data;
}

// ---- Unfurl API ----

export interface UnfurlResult {
  mediaUrl: string;
  width?: number;
  height?: number;
}

export async function apiUnfurl(url: string): Promise<UnfurlResult> {
  const response = await apiClient.get<UnfurlResult>('/api/unfurl', {
    params: { url },
  });
  return response.data;
}

export { getAccessToken, getRefreshToken, setTokens, clearTokens };
export default apiClient;
