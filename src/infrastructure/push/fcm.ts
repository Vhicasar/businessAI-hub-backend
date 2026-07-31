import { readFileSync } from 'fs';
import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';
import admin from 'firebase-admin';

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
// const ADMIN_APP = 'firebase-admin/app';
const ADMIN_MESSAGING = 'firebase-admin/messaging';

let appPromise: Promise<unknown | null> | null = null;

// function loadServiceAccount(): Record<string, unknown> | null {
//   try {
//     let raw = env.push.serviceAccountJson;
//     if (!raw && env.push.serviceAccountPath) raw = readFileSync(env.push.serviceAccountPath, 'utf8');
//     if (!raw) return null;
//     raw = raw.trim();

//     // Common env-var gotcha: the JSON is base64-encoded to survive shells/CI.
//     if (!raw.startsWith('{')) {
//       try {
//         raw = Buffer.from(raw, 'base64').toString('utf-8').trim();
//       } catch {
//         /* not base64 — fall through and let JSON.parse report */
//       }
//     }

//     const account = JSON.parse(raw) as Record<string, unknown>;
//     // The most common failure: the private key's newlines arrive escaped as
//     // literal "\n" (env vars can't hold real newlines). Restore them.
//     if (typeof account.private_key === 'string') {
//       account.private_key = account.private_key.replace(/\\n/g, '\n');
//     }
//     return account;
//   } catch (err) {
//     logger.error(
//       { err: (err as Error).message },
//       'FCM service account could not be parsed (expected JSON or base64-encoded JSON). Push is disabled.',
//     );
//   }
//   return null;
// }

function loadServiceAccount(): admin.ServiceAccount | null {
  try {
    let raw = env.push.serviceAccountJson;
    if (!raw && env.push.serviceAccountPath) raw = readFileSync(env.push.serviceAccountPath, 'utf8');
    if (!raw) return null;
    raw = raw.trim();
    if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8').trim();
    const account = JSON.parse(raw) as admin.ServiceAccount & { private_key?: string; privateKey?: string };
    if (typeof account.private_key === 'string') account.private_key = account.private_key.replace(/\\n/g, '\n');
    if (typeof account.privateKey === 'string') account.privateKey = account.privateKey.replace(/\\n/g, '\n');
    return account;
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      'FCM service account could not be parsed (expected JSON or base64-encoded JSON). Push is disabled.',
    );
  }
  return null;
}

let firebaseApp: admin.app.App | null | undefined;

function getApp(): admin.app.App | null {
  if (firebaseApp !== undefined) return firebaseApp;
  if (!env.push.enabled) return (firebaseApp = null);
  const account = loadServiceAccount();
  if (!account) return (firebaseApp = null);
  try {
    firebaseApp = admin.apps[0] ?? admin.initializeApp({ credential: admin.credential.cert(account) });
    logger.info({ projectId: account.projectId }, 'FCM push initialised');
    return firebaseApp;
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'FCM push initialisation failed');
    return (firebaseApp = null);
  }
  // appPromise ??= (async () => {
  //   const account = loadServiceAccount();
  //   if (!account) {
  //     logger.warn('Push is enabled but the FCM service account is missing/invalid — push will not send.');
  //     return null;
  //   }
  //   // const { initializeApp, getApps, cert } = await import(ADMIN_APP);
  //   // const existing = getApps();
  //   // if (existing.length) return existing[0];

  //   const app = admin.initializeApp({ credential: admin.credential.cert(account) });
  //   // const app = initializeApp({ credential: cert(account) });
    
  //   // logger.info({ projectId: account.project_id }, 'FCM (push) initialised');
  //   return app;
  // })();
  // return appPromise;
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
    return getApp() !== null;
  },

  /**
   * Multicast a notification to device tokens. Returns which tokens are dead so
   * the caller can delete them. Safe to call when push is disabled (no-op).
   */
  async sendToTokens(tokens: string[], payload: PushPayload): Promise<PushResult> {
    const unique = [...new Set(tokens)].filter(Boolean);
    const empty: PushResult = { successCount: 0, failureCount: 0, invalidTokens: [] };
    if (unique.length === 0) return empty;

    const app = getApp();
    if (!app) return empty;

    const sound = payload.sound || env.push.sound;
    const conversationId = payload.data?.conversationId;
    const groupTag = conversationId ? `chat-${conversationId}` : payload.data?.type || 'notification';
    // const { getMessaging } = await import(ADMIN_MESSAGING);
    // const messaging = getMessaging(app);
    const messaging = app.messaging();

    try {
      const res = await messaging.sendEachForMulticast({
        tokens: unique,
        notification: { title: payload.title, body: payload.body },
        // Duplicate the visible text in data so native web service workers can
        // display the notification even when the browser does not expose the
        // top-level notification object to the Push API event.
        data: { ...(payload.data ?? {}), title: payload.title, body: payload.body ?? '' },
        android: {
          priority: 'high',
          collapseKey: groupTag,
          notification: { sound, channelId: 'high_importance', defaultSound: false, tag: groupTag },
        },
        apns: {
          headers: { 'apns-collapse-id': groupTag },
          payload: { aps: { sound: `${sound}.wav`, badge: 1, threadId: groupTag } },
        },
        webpush: {
          headers: { Urgency: 'high' },
          notification: {
            title: payload.title,
            body: payload.body,
            icon: '/brand-icon.svg',
            tag: groupTag,
            renotify: true,
          },
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
