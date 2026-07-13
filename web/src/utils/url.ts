// safeHttpUrl returns the URL only if it is a valid absolute http(s) URL with a
// host, otherwise null. Used to keep javascript:, data:, and other non-navigable
// schemes out of href/src attributes on the client, as defense in depth even
// when the server validates the same fields on write.
export function safeHttpUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname) {
      return url;
    }
  } catch {
    // Not a valid absolute URL.
  }
  return null;
}
