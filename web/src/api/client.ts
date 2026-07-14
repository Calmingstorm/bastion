import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { wsClient } from './websocket';
import { storage } from '../utils/storage';
import {
  captureSessionGeneration,
  isSessionGenerationCurrent,
  onSessionInvalidated,
} from './session';
import type {
  User,
  Server,
  Channel,
  Message,
  MessageAuthor,
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
  PinnedMessage,
} from '../types';

// Configurable base URL — desktop sets this from stored server URL
let apiBaseURL = (import.meta.env.VITE_API_URL || '') + '/api/v1';

export function setApiBaseURL(url: string): void {
  apiBaseURL = url.replace(/\/+$/, '') + '/api/v1';
  apiClient.defaults.baseURL = apiBaseURL;
}

const apiClient = axios.create({
  baseURL: apiBaseURL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// A per-session AbortController whose signal is attached to every request.
// Logout aborts it, cancelling all in-flight requests at once — otherwise a
// response already underway when the user logs out could resolve afterward and
// write the previous user's data back into a freshly-reset store.
let sessionAbort = new AbortController();

// Abort `controller` when the current session is aborted (logout), and return an
// unlink to call once the request settles so the listener never outlives it. This
// lets a caller that supplies its own request signal (e.g. a per-fetch abort) still
// be cancelled by logout, without leaking a listener onto the long-lived session
// signal for a request that completes normally.
export function linkAbortToSession(controller: AbortController): () => void {
  const sig = sessionAbort.signal;
  if (sig.aborted) {
    controller.abort();
    return () => {};
  }
  const onAbort = () => controller.abort();
  sig.addEventListener('abort', onAbort);
  return () => sig.removeEventListener('abort', onAbort);
}

// abortInFlightRequests cancels every request currently in flight and starts a
// fresh session signal for subsequent requests. It is transport-level teardown
// only; the identity boundary itself is the session generation, which the caller
// (logout) must advance via invalidateSession() BEFORE calling this. The
// token-refresh path (a bare axios.post that apiClient's abort cannot cancel)
// captures that generation when it begins and refuses to write tokens if it moved.
export function abortInFlightRequests(): void {
  sessionAbort.abort();
  sessionAbort = new AbortController();
}

function getAccessToken(): string | null {
  return storage.getItem('accessToken');
}

function getRefreshToken(): string | null {
  return storage.getItem('refreshToken');
}

function setTokens(accessToken: string, refreshToken: string): void {
  storage.setItem('accessToken', accessToken);
  storage.setItem('refreshToken', refreshToken);
}

function clearTokens(): void {
  storage.removeItem('accessToken');
  storage.removeItem('refreshToken');
  storage.removeItem('user');
}

// Injectable navigation callback — override for non-browser platforms
let onAuthFailure: () => void = () => {
  window.location.href = '/login';
};

export function setAuthFailureHandler(handler: () => void): void {
  onAuthFailure = handler;
}

// Request interceptor: attach Bearer token
apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = getAccessToken();
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    // Stamp the request with the session generation it was issued under, so the 401
    // handler can refuse to refresh/retry a request from a session that has since
    // ended (which would otherwise refresh + retry it with the NEW account's creds).
    (config as InternalAxiosRequestConfig & { __sessionGeneration?: number }).__sessionGeneration =
      captureSessionGeneration();
    // Tie a request that has no signal of its own to the current session so logout
    // can cancel it. A caller that supplies its own signal is expected to link it to
    // the session itself (see linkAbortToSession) so it can unlink on settlement.
    if (!config.signal) {
      config.signal = sessionAbort.signal;
    }
    return config;
  },
  (error) => Promise.reject(error),
  // Run synchronously so the generation stamp + auth token are captured at the
  // moment the request is CREATED, not a microtask later -- otherwise a request
  // issued just before an identity boundary could be stamped as the new session's
  // and refresh with its credentials.
  { synchronous: true }
);

// Response interceptor: handle 401 with token refresh
let isRefreshing = false;
// The session generation the in-flight refresh belongs to. A refresh (and the
// requests queued behind it) serves only its own generation; if the session changes
// mid-refresh, current-session requests must not queue behind or inherit it.
let refreshGeneration = -1;
let failedQueue: Array<{
  resolve: (token: string) => void;
  reject: (error: unknown) => void;
  generation: number;
}> = [];

// Settle only the queued requests belonging to `generation` -- the refresh they were
// queued behind. failedQueue is shared across refreshes, so a superseded refresh
// settling must drain ITS OWN waiters (so they never hang) without disturbing the
// waiters of the replacement refresh that took over.
function processQueue(error: unknown, token: string | null, generation: number): void {
  const keep: typeof failedQueue = [];
  failedQueue.forEach((prom) => {
    if (prom.generation !== generation) {
      keep.push(prom);
    } else if (error) {
      prom.reject(error);
    } else if (token) {
      prom.resolve(token);
    }
  });
  failedQueue = keep;
}

// An identity boundary must settle prior-session waiters AT the boundary. Generation
// scoping alone only drains them when their refresh settles -- but the refresh is a
// bare axios.post that abortInFlightRequests() cannot cancel, so if it hangs, its
// queued requests would stay pending forever. Reject them here instead; their callers
// are generation-guarded and ignore the rejection.
onSessionInvalidated(() => {
  const stale = failedQueue.filter((prom) => !isSessionGenerationCurrent(prom.generation));
  if (stale.length === 0) return;
  failedQueue = failedQueue.filter((prom) => isSessionGenerationCurrent(prom.generation));
  stale.forEach((prom) => prom.reject(new Error('session changed')));
});

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
      // A 401 from an auth endpoint is a CREDENTIAL failure (bad login/register/
      // reset), not an expired session -- it must never enter the refresh path.
      // Login tears the old identity down first, so there is no refresh token;
      // routing this 401 through the refresh machinery invoked the auth-failure
      // cascade (another logout, another generation advance) and turned "invalid
      // credentials" into a silent SessionSupersededError.
      if ((originalRequest.url ?? '').startsWith('/auth/')) {
        return Promise.reject(error);
      }

      // A request issued under a session that has since ended must not refresh or
      // retry -- doing so would reuse the NEW account's credentials for the OLD
      // request. Reject it; its (session-guarded) caller ignores the result.
      const requestGeneration = (originalRequest as InternalAxiosRequestConfig & {
        __sessionGeneration?: number;
      }).__sessionGeneration;
      if (requestGeneration !== undefined && !isSessionGenerationCurrent(requestGeneration)) {
        return Promise.reject(error);
      }

      // If a refresh is in flight but belongs to a session that has since ended, do
      // not let current-session requests queue behind it and inherit its dead-session
      // outcome. Drop it (rejecting its own stale waiters) and start a fresh refresh
      // for the current session.
      if (isRefreshing && !isSessionGenerationCurrent(refreshGeneration)) {
        processQueue(new Error('session changed'), null, refreshGeneration);
        isRefreshing = false;
      }

      if (isRefreshing) {
        const queuedGeneration = refreshGeneration;
        return new Promise<string>((resolve, reject) => {
          failedQueue.push({ resolve, reject, generation: queuedGeneration });
        }).then((token) => {
          // The refresh resolved for the session this request was queued under, but
          // an identity boundary can land between that resolution and this
          // continuation. Retrying then would re-enter the interceptor, which would
          // re-stamp the old request with the NEW session's generation and bearer
          // token. Recheck before retrying; the caller is generation-guarded.
          if (!isSessionGenerationCurrent(queuedGeneration)) {
            return Promise.reject(error);
          }
          if (originalRequest.headers) {
            originalRequest.headers.Authorization = `Bearer ${token}`;
          }
          return apiClient(originalRequest);
        });
      }

      (originalRequest as InternalAxiosRequestConfig & { _retry?: boolean })._retry = true;
      isRefreshing = true;
      // The refresh belongs to the current session; capture it so its result is
      // discarded if an identity boundary passes before it resolves.
      refreshGeneration = captureSessionGeneration();
      const generationAtRefresh = refreshGeneration;

      const refreshToken = getRefreshToken();
      if (!refreshToken) {
        // Drain any queued requests and clear the refreshing flag, otherwise a
        // concurrent 401 that queued behind this one waits forever and every
        // later request skips refresh (isRefreshing stuck true).
        processQueue(error, null, generationAtRefresh);
        isRefreshing = false;
        clearTokens();
        onAuthFailure();
        return Promise.reject(error);
      }

      // The refresh is a bare axios.post that abortInFlightRequests() cannot cancel,
      // and the leader awaits it directly -- so a hung refresh would leave the leader
      // pending across an identity boundary even after its followers are drained.
      // Race the refresh against the boundary itself: invalidation settles the await.
      let boundaryReject!: (e: unknown) => void;
      const boundary = new Promise<never>((_resolve, reject) => {
        boundaryReject = reject;
      });
      const unsubscribeBoundary = onSessionInvalidated(() =>
        boundaryReject(new Error('session changed'))
      );

      try {
        const response = await Promise.race([
          axios.post<{ accessToken: string }>(`${apiBaseURL}/auth/refresh`, {
            refreshToken,
          }),
          boundary,
        ]);
        // A logout during the in-flight refresh must remain authoritative: do not
        // write the new tokens back or update the socket. Reject this refresh's own
        // stale waiters (matched by generation) so they don't hang, but leave a
        // replacement refresh's waiters -- which carry a newer generation -- untouched.
        if (!isSessionGenerationCurrent(generationAtRefresh)) {
          processQueue(new Error('session changed'), null, generationAtRefresh);
          return Promise.reject(error);
        }
        const { accessToken } = response.data;
        setTokens(accessToken, refreshToken);
        wsClient.updateToken(accessToken);
        processQueue(null, accessToken, generationAtRefresh);

        if (originalRequest.headers) {
          originalRequest.headers.Authorization = `Bearer ${accessToken}`;
        }
        return apiClient(originalRequest);
      } catch (refreshError) {
        // Reject this refresh's own queued waiters (matched by generation) so they
        // never hang -- whether or not the session has since moved on. A replacement
        // refresh's waiters carry a different generation and are left untouched.
        processQueue(refreshError, null, generationAtRefresh);
        // Only end the session when the refresh token itself is rejected. A
        // transient failure (network drop, 5xx) must not force a logout — leave
        // the tokens in place so the next request can retry. And only if this
        // refresh still belongs to the current session: a stale refresh (a newer
        // account logged in while it was in flight) rejecting must not clear the
        // new account's tokens or trigger its auth failure.
        const status = (refreshError as AxiosError)?.response?.status;
        if (
          (status === 401 || status === 403) &&
          isSessionGenerationCurrent(generationAtRefresh)
        ) {
          clearTokens();
          onAuthFailure();
        }
        return Promise.reject(refreshError);
      } finally {
        unsubscribeBoundary();
        // Clear the flag only if this refresh still owns it -- i.e. no replacement
        // took over. A replacement always starts under a newer generation and
        // reassigns refreshGeneration, so an unchanged refreshGeneration means we
        // still own isRefreshing, even if the session ended with no replacement
        // starting (in which case we DO clear it, rather than leaving it stuck true).
        if (refreshGeneration === generationAtRefresh) {
          isRefreshing = false;
        }
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
  const response = await apiClient.post<LoginResponse>('/auth/login', {
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
  const response = await apiClient.post<RegisterResponse>('/auth/register', {
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
  }>('/auth/refresh', { refreshToken });
  return response.data;
}

export async function apiGetMe(): Promise<User> {
  const response = await apiClient.get<User>('/users/me');
  return response.data;
}

// ---- User API ----

export async function apiUpdateProfile(data: {
  displayName?: string;
  aboutMe?: string;
  status?: string;
}): Promise<User> {
  const response = await apiClient.patch<User>('/users/me', data);
  return response.data;
}

export async function apiUploadAvatar(file: File): Promise<User> {
  const formData = new FormData();
  formData.append('avatar', file);
  const response = await apiClient.post<User>('/users/me/avatar', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return response.data;
}

export async function apiGetUser(userId: string): Promise<User> {
  const response = await apiClient.get<User>(`/users/${userId}`);
  return response.data;
}

// ---- Server API ----

export async function apiGetServers(): Promise<Server[]> {
  const response = await apiClient.get<Server[]>('/servers');
  return Array.isArray(response.data) ? response.data : [];
}

export async function apiCreateServer(name: string): Promise<Server> {
  const response = await apiClient.post<Server>('/servers', { name });
  return response.data;
}

export async function apiJoinServer(inviteCode: string): Promise<Server> {
  const response = await apiClient.post<Server>(`/invites/${inviteCode}/join`);
  return response.data;
}

// ---- Channel API ----

export async function apiGetChannels(serverId: string): Promise<Channel[]> {
  const response = await apiClient.get<Channel[]>(
    `/servers/${serverId}/channels`
  );
  return Array.isArray(response.data) ? response.data : [];
}

export async function apiCreateChannel(
  serverId: string,
  name: string,
  topic?: string,
  categoryId?: string
): Promise<Channel> {
  const body: Record<string, string | undefined> = { name, topic };
  if (categoryId) body.categoryId = categoryId;
  const response = await apiClient.post<Channel>(
    `/servers/${serverId}/channels`,
    body
  );
  return response.data;
}

export async function apiUpdateChannel(
  serverId: string,
  channelId: string,
  data: { name?: string; topic?: string; categoryId?: string }
): Promise<Channel> {
  const response = await apiClient.patch<Channel>(
    `/servers/${serverId}/channels/${channelId}`,
    data
  );
  return response.data;
}

export async function apiDeleteChannel(
  serverId: string,
  channelId: string
): Promise<void> {
  await apiClient.delete(`/servers/${serverId}/channels/${channelId}`);
}

// ---- Message API ----

export async function apiGetMessages(
  channelId: string,
  before?: string,
  limit: number = 50,
  signal?: AbortSignal
): Promise<Message[]> {
  const params: Record<string, string | number> = { limit };
  if (before) {
    params.before = before;
  }
  const response = await apiClient.get<Message[]>(
    `/channels/${channelId}/messages`,
    { params, signal }
  );
  return Array.isArray(response.data) ? response.data : [];
}

export async function apiSendMessage(
  channelId: string,
  content: string,
  replyToId?: string
): Promise<Message> {
  const body: Record<string, string> = { content };
  if (replyToId) body.replyToId = replyToId;
  const response = await apiClient.post<Message>(
    `/channels/${channelId}/messages`,
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
    `/channels/${channelId}/messages/${messageId}`,
    { content }
  );
  return response.data;
}

export async function apiDeleteMessage(
  channelId: string,
  messageId: string
): Promise<void> {
  await apiClient.delete(`/channels/${channelId}/messages/${messageId}`);
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
    `/channels/${channelId}/messages/upload`,
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
    `/servers/${serverId}/invites`,
    options || {}
  );
  return response.data;
}

export async function apiGetInvites(serverId: string): Promise<ServerInvite[]> {
  const response = await apiClient.get<ServerInvite[]>(
    `/servers/${serverId}/invites`
  );
  return response.data;
}

export async function apiDeleteInvite(inviteId: string): Promise<void> {
  await apiClient.delete(`/invites/${inviteId}`);
}

export async function apiJoinViaInvite(code: string): Promise<Server> {
  const response = await apiClient.post<Server>(`/invites/${code}/join`);
  return response.data;
}

// ---- DM API ----

export async function apiCreateDM(recipientIds: string[]): Promise<DMChannel> {
  const response = await apiClient.post<DMChannel>('/dm', { recipientIds });
  return response.data;
}

export async function apiGetDMs(): Promise<DMChannel[]> {
  const response = await apiClient.get<DMChannel[]>('/dm');
  return Array.isArray(response.data) ? response.data : [];
}

export async function apiCloseDM(channelId: string): Promise<void> {
  await apiClient.post(`/dm/${channelId}/close`);
}

export async function apiGetDM(channelId: string): Promise<DMChannel> {
  const response = await apiClient.get<DMChannel>(`/dm/${channelId}`);
  return response.data;
}

// ---- Read State API ----

export async function apiAckChannel(
  channelId: string,
  messageId: string
): Promise<void> {
  await apiClient.post(`/channels/${channelId}/ack`, { messageId });
}

export async function apiGetReadStates(): Promise<ReadState[]> {
  const response = await apiClient.get<ReadState[]>('/users/me/read-states');
  return Array.isArray(response.data) ? response.data : [];
}

// ---- Members API ----

export async function apiGetMembers(serverId: string): Promise<MemberWithUser[]> {
  const response = await apiClient.get<MemberWithUser[]>(
    `/servers/${serverId}/members`
  );
  return response.data;
}

// ---- Password Reset API ----

export async function apiForgotPassword(
  email: string
): Promise<{ message: string }> {
  const response = await apiClient.post<{ message: string }>(
    '/auth/forgot-password',
    { email }
  );
  return response.data;
}

export async function apiResetPassword(
  token: string,
  password: string
): Promise<{ message: string }> {
  const response = await apiClient.post<{ message: string }>(
    '/auth/reset-password',
    { token, password }
  );
  return response.data;
}

// ---- Server Settings API ----

export async function apiUpdateServer(
  serverId: string,
  data: { name?: string; description?: string }
): Promise<Server> {
  const response = await apiClient.patch<Server>(`/servers/${serverId}`, data);
  return response.data;
}

export async function apiUploadServerIcon(serverId: string, file: File): Promise<Server> {
  const formData = new FormData();
  formData.append('icon', file);
  const response = await apiClient.post<Server>(`/servers/${serverId}/icon`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return response.data;
}

// ---- Roles API ----

export async function apiGetRoles(serverId: string): Promise<Role[]> {
  const response = await apiClient.get<Role[]>(`/servers/${serverId}/roles`);
  return response.data;
}

export async function apiCreateRole(
  serverId: string,
  data: { name: string; color?: string; permissions?: number }
): Promise<Role> {
  const response = await apiClient.post<Role>(`/servers/${serverId}/roles`, data);
  return response.data;
}

export async function apiUpdateRole(
  serverId: string,
  roleId: string,
  data: { name?: string; color?: string; permissions?: number }
): Promise<Role> {
  const response = await apiClient.patch<Role>(
    `/servers/${serverId}/roles/${roleId}`,
    data
  );
  return response.data;
}

export async function apiDeleteRole(serverId: string, roleId: string): Promise<void> {
  await apiClient.delete(`/servers/${serverId}/roles/${roleId}`);
}

export async function apiAssignRole(
  serverId: string,
  roleId: string,
  userId: string
): Promise<void> {
  await apiClient.post(`/servers/${serverId}/roles/${roleId}/assign`, { userId });
}

export async function apiRemoveRole(
  serverId: string,
  roleId: string,
  userId: string
): Promise<void> {
  await apiClient.post(`/servers/${serverId}/roles/${roleId}/remove`, { userId });
}

export async function apiGetMemberPermissions(
  serverId: string
): Promise<{ permissions: number }> {
  const response = await apiClient.get<{ permissions: number }>(
    `/servers/${serverId}/permissions`
  );
  return response.data;
}

// ---- Categories API ----

export async function apiGetCategories(serverId: string): Promise<ChannelCategory[]> {
  const response = await apiClient.get<ChannelCategory[]>(
    `/servers/${serverId}/categories`
  );
  return response.data;
}

export async function apiCreateCategory(
  serverId: string,
  name: string
): Promise<ChannelCategory> {
  const response = await apiClient.post<ChannelCategory>(
    `/servers/${serverId}/categories`,
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
    `/servers/${serverId}/categories/${categoryId}`,
    data
  );
  return response.data;
}

export async function apiDeleteCategory(
  serverId: string,
  categoryId: string
): Promise<void> {
  await apiClient.delete(`/servers/${serverId}/categories/${categoryId}`);
}

// ---- Moderation API ----

export async function apiKickMember(
  serverId: string,
  userId: string,
  reason?: string
): Promise<void> {
  await apiClient.post(`/servers/${serverId}/kick/${userId}`, { reason });
}

export async function apiBanMember(
  serverId: string,
  userId: string,
  reason?: string
): Promise<void> {
  await apiClient.post(`/servers/${serverId}/bans/${userId}`, { reason });
}

export async function apiUnbanMember(
  serverId: string,
  userId: string
): Promise<void> {
  await apiClient.delete(`/servers/${serverId}/bans/${userId}`);
}

export async function apiGetBans(serverId: string): Promise<ServerBan[]> {
  const response = await apiClient.get<ServerBan[]>(`/servers/${serverId}/bans`);
  return response.data;
}

export async function apiTimeoutMember(
  serverId: string,
  userId: string,
  duration: number,
  reason?: string
): Promise<void> {
  await apiClient.post(`/servers/${serverId}/timeout/${userId}`, {
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
    `/servers/${serverId}/audit-log`,
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
  await apiClient.put(`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
}

export async function apiRemoveReaction(
  channelId: string,
  messageId: string,
  emoji: string
): Promise<void> {
  await apiClient.delete(`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
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
  const response = await apiClient.get<SearchResult[]>('/search', { params });
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
  const response = await apiClient.get<GifResult[]>('/gifs/search', {
    params: { q: query, limit },
  });
  return response.data;
}

export async function apiTrendingGifs(limit = 20): Promise<GifResult[]> {
  const response = await apiClient.get<GifResult[]>('/gifs/trending', {
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
  const response = await apiClient.get<UnfurlResult>('/unfurl', {
    params: { url },
  });
  return response.data;
}

// ---- Leave / Delete Server API ----

export async function apiLeaveServer(serverId: string): Promise<void> {
  await apiClient.delete(`/servers/${serverId}/leave`);
}

export async function apiDeleteServer(serverId: string): Promise<void> {
  await apiClient.delete(`/servers/${serverId}`);
}

// ---- Account Management API ----

export async function apiChangePassword(
  currentPassword: string,
  newPassword: string
): Promise<void> {
  await apiClient.post('/users/me/change-password', {
    currentPassword,
    newPassword,
  });
}

export async function apiChangeEmail(
  newEmail: string,
  password: string
): Promise<User> {
  const response = await apiClient.post<User>('/users/me/change-email', {
    newEmail,
    password,
  });
  return response.data;
}

export async function apiDeleteAccount(password: string): Promise<void> {
  await apiClient.delete('/users/me', { data: { password } });
}

// ---- Nickname API ----

export async function apiUpdateNickname(
  serverId: string,
  userId: string,
  nickname: string
): Promise<void> {
  await apiClient.patch(
    `/servers/${serverId}/members/${userId}/nickname`,
    { nickname }
  );
}

// ---- Pin API ----

export async function apiPinMessage(
  channelId: string,
  messageId: string
): Promise<void> {
  await apiClient.put(
    `/channels/${channelId}/pins/${messageId}`
  );
}

export async function apiUnpinMessage(
  channelId: string,
  messageId: string
): Promise<void> {
  await apiClient.delete(
    `/channels/${channelId}/pins/${messageId}`
  );
}

export async function apiGetPinnedMessages(
  channelId: string
): Promise<PinnedMessage[]> {
  const response = await apiClient.get<PinnedMessage[]>(
    `/channels/${channelId}/pins`
  );
  return response.data;
}

// ---- User Search API ----

export async function apiSearchUsers(query: string): Promise<MessageAuthor[]> {
  const response = await apiClient.get<MessageAuthor[]>('/users/search', {
    params: { q: query },
  });
  return response.data;
}

// ---- Channel Reorder API ----

export async function apiReorderChannels(
  serverId: string,
  positions: { id: string; position: number; categoryId?: string }[]
): Promise<void> {
  await apiClient.put(`/servers/${serverId}/channels/reorder`, positions);
}

// ---- Webhook API ----

import type { Webhook, Bot, ApplicationCommand } from '../types';

export async function apiGetWebhooks(serverId: string): Promise<Webhook[]> {
  const response = await apiClient.get<Webhook[]>(`/servers/${serverId}/webhooks`);
  return response.data;
}

export async function apiCreateWebhook(
  serverId: string,
  data: { name: string; channelId: string }
): Promise<Webhook> {
  const response = await apiClient.post<Webhook>(`/servers/${serverId}/webhooks`, data);
  return response.data;
}

export async function apiUpdateWebhook(
  serverId: string,
  webhookId: string,
  data: { name?: string; channelId?: string }
): Promise<Webhook> {
  const response = await apiClient.patch<Webhook>(
    `/servers/${serverId}/webhooks/${webhookId}`,
    data
  );
  return response.data;
}

export async function apiDeleteWebhook(
  serverId: string,
  webhookId: string
): Promise<void> {
  await apiClient.delete(`/servers/${serverId}/webhooks/${webhookId}`);
}

export async function apiRegenerateWebhookToken(
  serverId: string,
  webhookId: string
): Promise<Webhook> {
  const response = await apiClient.post<Webhook>(
    `/servers/${serverId}/webhooks/${webhookId}/regenerate-token`
  );
  return response.data;
}

// ---- Bot API ----

export async function apiGetBots(serverId: string): Promise<Bot[]> {
  const response = await apiClient.get<Bot[]>(`/servers/${serverId}/bots`);
  return response.data;
}

export async function apiCreateBot(
  serverId: string,
  data: { username: string; description?: string }
): Promise<Bot> {
  const response = await apiClient.post<Bot>(`/servers/${serverId}/bots`, data);
  return response.data;
}

export async function apiUpdateBot(
  serverId: string,
  botId: string,
  data: { username?: string; description?: string }
): Promise<Bot> {
  const response = await apiClient.patch<Bot>(
    `/servers/${serverId}/bots/${botId}`,
    data
  );
  return response.data;
}

export async function apiDeleteBot(
  serverId: string,
  botId: string
): Promise<void> {
  await apiClient.delete(`/servers/${serverId}/bots/${botId}`);
}

export async function apiRegenerateBotToken(
  serverId: string,
  botId: string
): Promise<{ token: string }> {
  const response = await apiClient.post<{ token: string }>(
    `/servers/${serverId}/bots/${botId}/regenerate-token`
  );
  return response.data;
}

// ---- Interactions API ----

export async function apiGetServerCommands(serverId: string): Promise<ApplicationCommand[]> {
  const response = await apiClient.get<ApplicationCommand[]>(`/servers/${serverId}/commands`);
  return Array.isArray(response.data) ? response.data : [];
}

export async function apiExecuteInteraction(
  serverId: string,
  data: { commandId: string; channelId: string; options?: { name: string; value: string }[]; targetId?: string }
): Promise<void> {
  await apiClient.post(`/servers/${serverId}/interactions`, data);
}

export { getAccessToken, getRefreshToken, setTokens, clearTokens };
export default apiClient;
