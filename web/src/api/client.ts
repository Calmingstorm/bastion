import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import type {
  User,
  Server,
  Channel,
  Message,
  LoginResponse,
  RegisterResponse,
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
  const response = await apiClient.post<Server>(`/api/servers/join`, {
    inviteCode,
  });
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
  content: string
): Promise<Message> {
  const response = await apiClient.post<Message>(
    `/api/channels/${channelId}/messages`,
    { content }
  );
  return response.data;
}

export { getAccessToken, getRefreshToken, setTokens, clearTokens };
export default apiClient;
