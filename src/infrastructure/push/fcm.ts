import { readFileSync } from 'fs';
import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';

/**
 * Firebase Cloud Messaging sender.
 *
 * Lazily initialises the Admin SDK from a service account (inline JSON or a key
 * file path — see env.push). When no credentials are configured, push is a
 * no-op so the rest of the notification pipeline (in-app + realtime) still runs.
 *
 * `firebase-admin` is loaded via a non-analysable dynamic import so the backend
 * type-checks and boots even before the dependency is installed; it's only
 * required at runtime when push is actually configured.
 */

// Non-literal specifiers so tsc doesn't require the module to be present.
const ADMIN_APP = 'firebase-admin/app';
const ADMIN_MESSAGING = 'firebase-admin/messaging';

let appPromise: Promise<unknown | null> | null = null;

function loadServiceAccount(): Record<string, unknown> | null {
  try {
    if (env.push.serviceAccountJson) {
      return JSON.parse(env.push.serviceAccountJson) as Record<string, unknown>;
    }
    if (env.push.serviceAccountPath) {
      return JSON.parse(readFileSync(env.push.serviceAccountPath, 'utf8')) as Record<string, unknown>;
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'FCM service account is invalid JSON');
  }
  return null;
}

async function getApp(): Promise<unknown | null> {
  if (!env.push.enabled) return null;
  appPromise ??= (async () => {
    const account = loadServiceAccount();
    if (!account) return null;
    const { initializeApp, getApps, cert } = await import(ADMIN_APP);
    const existing = getApps();
    if (existing.length) return existing[0];
    return initializeApp({ credential: cert(account) });
  })();
  return appPromise;
}

export interface PushPayload {
  title: string;
  body?: string;
  /** Deep-link data — values must be strings for FCM data messages. */
  data?: Record<string, string>;
  /** Custom sound name (Android raw resource / iOS file, no path). */
  sound?: string;
}

export interface PushResult {
  successCount: number;
  failureCount: number;
  /** Tokens FCM reports as unregistered/invalid — callers should prune these. */
  invalidTokens: string[];
}

const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

export const fcm = {
  get enabled(): boolean {
    return env.push.enabled;
  },

  /**
   * Multicast a notification to device tokens. Returns which tokens are dead so
   * the caller can delete them. Safe to call when push is disabled (no-op).
   */
  async sendToTokens(tokens: string[], payload: PushPayload): Promise<PushResult> {
    const unique = [...new Set(tokens)].filter(Boolean);
    const empty: PushResult = { successCount: 0, failureCount: 0, invalidTokens: [] };
    if (unique.length === 0) return empty;

    const app = await getApp();
    if (!app) return empty;

    const sound = payload.sound || env.push.sound;
    const { getMessaging } = await import(ADMIN_MESSAGING);
    const messaging = getMessaging(app);

    try {
      const res = await messaging.sendEachForMulticast({
        tokens: unique,
        notification: { title: payload.title, body: payload.body },
        data: payload.data ?? {},
        android: {
          priority: 'high',
          notification: { sound, channelId: 'high_importance', defaultSound: false },
        },
        apns: {
          payload: { aps: { sound: `${sound}.wav`, badge: 1 } },
        },
        webpush: {
          notification: { title: payload.title, body: payload.body, icon: '/favicon.svg' },
          fcmOptions: payload.data?.link ? { link: payload.data.link } : undefined,
        },
      });

      const invalidTokens: string[] = [];
      (res.responses as Array<{ error?: { code?: string } }>).forEach((r, i) => {
        if (r.error?.code && DEAD_TOKEN_CODES.has(r.error.code)) invalidTokens.push(unique[i]!);
      });

      return { successCount: res.successCount, failureCount: res.failureCount, invalidTokens };
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'FCM multicast failed');
      return empty;
    }
  },
};
