import { describe, expect, it } from 'vitest';
import {
  updateConversationListFromRealtime,
  updateThreadFromRealtime,
  type RealtimeMessagePayload,
} from '../../../web/src/features/inbox/realtimeInbox';

const payload: RealtimeMessagePayload = {
  conversationId: 'conversation-1',
  message: {
    id: 'message-2', direction: 'INBOUND', authorType: 'CUSTOMER', contentType: 'TEXT',
    body: 'A second message', status: 'DELIVERED', aiGenerated: false,
    createdAt: '2026-09-28T10:01:00.000Z',
  },
  conversation: {
    unreadCount: 2,
    lastMessageAt: '2026-09-28T10:01:00.000Z',
    lastMessageText: 'A second message',
  },
};

const initialThread = {
  id: 'conversation-1', unreadCount: 1,
  lastMessageAt: '2026-09-28T10:00:00.000Z', lastMessageText: 'First',
  messages: [{ ...payload.message, id: 'message-1', body: 'First', createdAt: '2026-09-28T10:00:00.000Z' }],
};

describe('unified inbox realtime state', () => {
  it('updates an actively viewed thread without leaving it unread', () => {
    const result = updateThreadFromRealtime(initialThread, payload, true)!;
    expect(result.messages.map((message) => message.id)).toEqual(['message-1', 'message-2']);
    expect(result.unreadCount).toBe(0);
    expect(result.lastMessageText).toBe('A second message');
  });

  it('uses the authoritative server unread count for an inactive conversation', () => {
    const result = updateConversationListFromRealtime({ items: [initialThread] }, payload, false)!;
    expect(result.items[0]?.unreadCount).toBe(2);
    expect(result.items[0]?.lastMessageAt).toBe('2026-09-28T10:01:00.000Z');
  });

  it('is idempotent when org and conversation rooms deliver the same event', () => {
    const once = updateThreadFromRealtime(initialThread, payload, false)!;
    const twice = updateThreadFromRealtime(once, payload, false)!;
    expect(twice.messages.filter((message) => message.id === 'message-2')).toHaveLength(1);
    expect(twice.unreadCount).toBe(2);
  });

  it('moves the updated conversation to the top without duplicating it', () => {
    const other = { ...initialThread, id: 'conversation-2' };
    const result = updateConversationListFromRealtime({ items: [other, initialThread] }, payload, false)!;
    expect(result.items.map((conversation) => conversation.id)).toEqual(['conversation-1', 'conversation-2']);
  });

  it('keeps rapid authoritative unread updates monotonic', () => {
    const third = {
      ...payload,
      message: { ...payload.message, id: 'message-3', body: 'Third' },
      conversation: { ...payload.conversation!, unreadCount: 3, lastMessageText: 'Third' },
    };
    const afterSecond = updateConversationListFromRealtime({ items: [initialThread] }, payload, false)!;
    const afterThird = updateConversationListFromRealtime(afterSecond, third, false)!;
    expect(afterThird.items[0]).toMatchObject({ unreadCount: 3, lastMessageText: 'Third' });
  });

  it('uses the event-time active conversation when the user switches threads', () => {
    const activeResult = updateConversationListFromRealtime({ items: [initialThread] }, payload, true)!;
    const inactiveResult = updateConversationListFromRealtime({ items: [initialThread] }, payload, false)!;
    expect(activeResult.items[0]?.unreadCount).toBe(0);
    expect(inactiveResult.items[0]?.unreadCount).toBe(2);
  });
});
