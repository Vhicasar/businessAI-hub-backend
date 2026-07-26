/**
 * Catalog of notifiable events shown in the per-user notification settings.
 * Preferences are keyed by these `key`s (plus the special "*" master key and
 * "platform:<platform>" keys), so adding an event here surfaces a toggle for it
 * on web and mobile without further changes.
 */
export interface NotificationType {
  key: string;
  label: string;
  description: string;
}

export const NOTIFICATION_TYPES: NotificationType[] = [
  { key: 'inbox.handoff', label: 'Chat handoffs', description: 'A conversation needs a human agent' },
  { key: 'inbox.assigned', label: 'Assigned to me', description: 'A conversation is assigned to you' },
  { key: 'inbox.message', label: 'New messages', description: 'New inbound customer messages' },
  { key: 'ticket.created', label: 'New support tickets', description: 'A support ticket is created' },
  { key: 'order.created', label: 'New orders', description: 'A new order is placed' },
  { key: 'order.paid', label: 'Payments received', description: 'An order or invoice is paid' },
  { key: 'lead.new', label: 'New leads', description: 'A new lead is captured' },
  { key: 'sms.low_balance', label: 'SMS low balance', description: 'Your SMS wallet is running low' },
];

/** Push-capable client platforms a user can toggle independently. */
export const PUSH_PLATFORMS = ['web', 'android', 'ios'] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

export const MASTER_KEY = '*';
export const platformKey = (platform: string): string => `platform:${platform}`;
