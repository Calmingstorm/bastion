export function showNotification(title: string, body: string, icon?: string): void {
  if (
    typeof window === 'undefined' ||
    !('Notification' in window) ||
    Notification.permission !== 'granted' ||
    !document.hidden
  ) {
    return;
  }

  new Notification(title, {
    body,
    icon: icon || '/favicon.ico',
  });
}
