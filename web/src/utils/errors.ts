/**
 * Extract a human-readable error message from an API error response.
 * Handles both old format ({ error: "msg" }) and new structured format
 * ({ error: { code: "CODE", message: "msg" } }).
 */
export function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const axiosErr = err as {
      response?: {
        data?: {
          message?: string;
          error?: string | { code?: string; message?: string };
        };
      };
    };
    const data = axiosErr.response?.data;
    if (data) {
      // New structured format: { error: { code, message } }
      if (data.error && typeof data.error === 'object' && data.error.message) {
        return data.error.message;
      }
      // Old format: { message: "..." }
      if (data.message) {
        return data.message;
      }
      // Old format: { error: "..." }
      if (typeof data.error === 'string') {
        return data.error;
      }
    }
  }
  return fallback;
}

/**
 * True when a request was cancelled (e.g. its abort signal fired on logout),
 * rather than genuinely failing. Callers use this to avoid surfacing a
 * user-facing error for an intentional cancellation.
 */
export function isAbort(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: string };
  return e.name === 'AbortError' || e.name === 'CanceledError' || e.code === 'ERR_CANCELED';
}
