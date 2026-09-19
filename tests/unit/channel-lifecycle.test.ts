import { describe, expect, it } from 'vitest';
import {
  countsTowardChannelLimit,
  connectionWouldAddActiveCapacity,
} from '../../src/application/inbox/channel-allowance.service';

const row = (status: string, isActive = status === 'CONNECTED', deletedAt: Date | null = null) => ({
  status, isActive, deletedAt,
});

describe('channel lifecycle capacity policy', () => {
  it.each(['ERROR', 'CONNECTING', 'DISCONNECTED', 'EXPIRED'])(
    '%s does not consume channel quota',
    (status) => expect(countsTowardChannelLimit(row(status, false))).toBe(false),
  );

  it('soft-deleted and inactive records do not consume channel quota', () => {
    expect(countsTowardChannelLimit(row('CONNECTED', true, new Date()))).toBe(false);
    expect(countsTowardChannelLimit(row('CONNECTED', false))).toBe(false);
  });

  it('only an active non-deleted CONNECTED record consumes quota', () => {
    expect(countsTowardChannelLimit(row('CONNECTED'))).toBe(true);
  });

  it('failed and disconnected retries require a free slot but are not blocked by their own row', () => {
    expect(connectionWouldAddActiveCapacity(row('ERROR', false))).toBe(true);
    expect(connectionWouldAddActiveCapacity(row('DISCONNECTED', false, new Date()))).toBe(true);
  });

  it('refreshing the same connected integration does not add active usage', () => {
    expect(connectionWouldAddActiveCapacity(row('CONNECTED'))).toBe(false);
  });

  it('a brand-new provider account requires a free slot', () => {
    expect(connectionWouldAddActiveCapacity(null)).toBe(true);
  });
});
