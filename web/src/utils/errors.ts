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
