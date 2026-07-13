import type { Webhook } from '../types';

// WebhookSummary is a webhook safe to hold in persistent client state: the type
// itself forbids the plaintext token, which is one-time and must live only in
// the transient reveal state. A bare Omit<Webhook,'token'> is not enough —
// structural typing still lets a token-bearing Webhook be assigned to it — so
// `token?: never` makes any token-carrying value fail to type-check.
export type WebhookSummary = Omit<Webhook, 'token'> & { token?: never };

// toWebhookSummary strips the plaintext token from a create/regenerate response
// before it is stored in the persistent list, so a dismissed token does not
// linger in memory.
export function toWebhookSummary(wh: Webhook): WebhookSummary {
  const { token: _token, ...summary } = wh;
  void _token;
  return summary;
}
