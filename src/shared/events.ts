/** Socket.IO event names — shared between backend gateway and all clients. */
export const SOCKET_EVENTS = {
  // inbox
  INBOX_MESSAGE_NEW: 'inbox:message.new',
  INBOX_MESSAGE_STATUS: 'inbox:message.status',
  INBOX_CONVERSATION_ASSIGNED: 'inbox:conversation.assigned',
  INBOX_CONVERSATION_STATUS: 'inbox:conversation.status',
  INBOX_TYPING: 'inbox:typing',
  // orders
  ORDER_CREATED: 'orders:created',
  ORDER_STATUS_CHANGED: 'orders:status.changed',
  // notifications & presence
  NOTIFICATION_NEW: 'notifications:new',
  PRESENCE_CHANGED: 'presence:changed',
  // money — emitted the moment it happens so no screen waits for a refresh
  PAYMENT_RECEIVED: 'payments:received',
  PAYMENT_STATUS_CHANGED: 'payments:status.changed',
  WALLET_UPDATED: 'wallet:updated',
  SETTLEMENT_UPDATED: 'settlement:updated',
  // calls (WebRTC signaling)
  CALL_SIGNAL: 'call:signal',
} as const;

export type SocketEvent = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];

export const socketRooms = {
  org: (orgId: string) => `org:${orgId}`,
  user: (userId: string) => `user:${userId}`,
  conversation: (id: string) => `conversation:${id}`,
  branch: (id: string) => `branch:${id}`,
};
