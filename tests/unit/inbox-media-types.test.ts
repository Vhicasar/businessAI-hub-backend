import { describe, expect, it } from 'vitest';
import { isAllowedUploadType } from '../../src/application/files/files.service';

describe('inbound inbox media types', () => {
  it('accepts Instagram reel video and common channel voice-note formats', () => {
    expect(isAllowedUploadType('video/mp4', 'inbox-media')).toBe(true);
    expect(isAllowedUploadType('audio/ogg', 'inbox-media')).toBe(true);
    expect(isAllowedUploadType('audio/opus', 'inbox-media')).toBe(true);
  });

  it('does not broaden ordinary image and document uploads', () => {
    expect(isAllowedUploadType('video/mp4', 'image')).toBe(false);
    expect(isAllowedUploadType('video/mp4', 'any')).toBe(false);
    expect(isAllowedUploadType('application/pdf', 'any')).toBe(true);
  });

  it('still rejects executable and unclassified payloads from providers', () => {
    expect(isAllowedUploadType('application/x-msdownload', 'inbox-media')).toBe(false);
    expect(isAllowedUploadType('application/octet-stream', 'inbox-media')).toBe(false);
  });
});
