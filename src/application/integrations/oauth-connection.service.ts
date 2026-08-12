import { createHmac, timingSafeEqual } from 'crypto';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { encrypt, decrypt } from '../../shared/crypto';
import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';
import { AppError, NotFoundError } from '../../shared/errors';
import {
  buildAuthorizeUrl,
  exchangeCode,
  oauthProvider,
  refreshTokens,
  revokeToken,
  type OAuthTokens,
} from './oauth-providers';

/**
 * The stored side of an OAuth connection.
 *
 * Tokens live in the existing IntegrationCredential row, encrypted at rest in
 * `credentialsEnc`, exactly like a pasted API key. What is safe to show — the
 * account label, when it was connected, whether it needs re-authorising — goes
 * in `metadata`, so listing connections never has to decrypt a secret.
 */

interface StoredOAuth {
  accessToken: string;
  refreshToken: string | null;
  /** ISO string; JSON has no Date. */
  expiresAt: string | null;
  scope: string | null;
  externalId: string | null;
}

export interface ConnectionMetadata {
  name: string;
  kind: 'oauth';
  accountLabel: string | null;
  externalId: string | null;
  connectedAt: string;
  /** Set when a refresh has failed: the user must reconnect. */
  needsReauth?: boolean;
  lastError?: string;
}

/**
 * The callback arrives on a browser redirect with no session, so the tenant
 * has to travel in the `state` parameter. Signing it is what stops one business
 * from pointing a callback at another's organisation.
 */
interface StatePayload {
  organizationId: string;
  userId: string;
  provider: string;
  /** Where to send the browser once the exchange is done. */
  returnTo: string;
  issuedAt: number;
}

const STATE_TTL_MS = 10 * 60 * 1000;

function stateSecret(): string {
  // Reuses the app's signing key as HMAC input; a separate secret would be one
  // more thing to rotate for no extra isolation.
  return env.jwt.signKey;
}

export function signState(payload: StatePayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', stateSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyState(state: string): StatePayload {
  const [body, sig] = state.split('.');
  if (!body || !sig) throw new AppError('OAUTH_STATE_INVALID', 400, 'Malformed sign-in state.');
  const expected = createHmac('sha256', stateSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AppError('OAUTH_STATE_INVALID', 400, 'Sign-in state failed verification.');
  }
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as StatePayload;
  if (Date.now() - payload.issuedAt > STATE_TTL_MS) {
    throw new AppError('OAUTH_STATE_EXPIRED', 400, 'This sign-in link has expired. Try connecting again.');
  }
  return payload;
}

function readStored(credentialsEnc: string): StoredOAuth | null {
  try {
    const parsed = JSON.parse(decrypt(credentialsEnc)) as Partial<StoredOAuth>;
    if (!parsed.accessToken) return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken ?? null,
      expiresAt: parsed.expiresAt ?? null,
      scope: parsed.scope ?? null,
      externalId: parsed.externalId ?? null,
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'integration credentials could not be read');
    return null;
  }
}

function toStored(tokens: OAuthTokens, externalId: string | null): StoredOAuth {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt ? tokens.expiresAt.toISOString() : null,
    scope: tokens.scope,
    externalId,
  };
}

export const oauthConnections = {
  /** The URL to send the user to, having checked they may connect this. */
  startUrl(input: { provider: string; organizationId: string; userId: string; returnTo: string }): string {
    const def = oauthProvider(input.provider);
    if (!def) throw new NotFoundError('Integration');
    if (!def.configured()) {
      // Better an honest message than a redirect to a provider error page.
      throw new AppError(
        'OAUTH_NOT_CONFIGURED',
        503,
        `${def.name} sign-in is not available yet — the platform has no ${def.name} app configured.`
      );
    }
    return buildAuthorizeUrl(
      def,
      signState({
        organizationId: input.organizationId,
        userId: input.userId,
        provider: input.provider,
        returnTo: input.returnTo,
        issuedAt: Date.now(),
      })
    );
  },

  /** Exchange the code and store the connection. Returns where to redirect. */
  async completeCallback(input: { code: string; state: string }): Promise<{ returnTo: string; provider: string }> {
    const payload = verifyState(input.state);
    const def = oauthProvider(payload.provider);
    if (!def) throw new NotFoundError('Integration');

    const tokens = await exchangeCode(def, input.code);
    if (!tokens.accessToken) throw new AppError('OAUTH_EXCHANGE_FAILED', 502, 'The provider returned no access token.');

    // Who did they actually connect? Worth knowing, but not worth failing the
    // connection over if the identity call is unavailable.
    let account = { label: null as string | null, externalId: null as string | null };
    try {
      const identified = await def.identify(tokens.accessToken);
      account = { label: identified.label, externalId: identified.externalId };
    } catch (err) {
      logger.warn({ err: (err as Error).message, provider: def.id }, 'connected account could not be identified');
    }

    const metadata: ConnectionMetadata = {
      name: def.name,
      kind: 'oauth',
      accountLabel: account.label,
      externalId: account.externalId,
      connectedAt: new Date().toISOString(),
      needsReauth: false,
    };

    // Unscoped: the callback carries no session, so the tenant comes from the
    // signed state rather than from request context.
    await prismaUnscoped.integrationCredential.upsert({
      where: { organizationId_provider: { organizationId: payload.organizationId, provider: def.id } },
      update: {
        credentialsEnc: encrypt(JSON.stringify(toStored(tokens, account.externalId))),
        isActive: true,
        metadata: metadata as unknown as object,
      },
      create: {
        organizationId: payload.organizationId,
        provider: def.id,
        credentialsEnc: encrypt(JSON.stringify(toStored(tokens, account.externalId))),
        metadata: metadata as unknown as object,
      },
    });

    return { returnTo: payload.returnTo, provider: def.id };
  },

  /**
   * A usable access token, refreshed if it is at or near expiry.
   *
   * Returns null when there is no connection or it needs re-authorising —
   * callers treat that as "not connected" rather than as an error, so a lapsed
   * integration degrades instead of breaking the feature that uses it.
   */
  async accessToken(provider: string, organizationId: string): Promise<string | null> {
    const def = oauthProvider(provider);
    if (!def) return null;
    const row = await prismaUnscoped.integrationCredential.findUnique({
      where: { organizationId_provider: { organizationId, provider } },
    });
    if (!row || !row.isActive) return null;

    const stored = readStored(row.credentialsEnc);
    if (!stored) return null;

    const expired = stored.expiresAt !== null && new Date(stored.expiresAt) <= new Date();
    if (!expired) return stored.accessToken;

    if (!stored.refreshToken) {
      await this.markNeedsReauth(organizationId, provider, 'The connection expired and cannot be renewed.');
      return null;
    }

    try {
      const refreshed = await refreshTokens(def, stored.refreshToken);
      await prismaUnscoped.integrationCredential.update({
        where: { id: row.id },
        data: {
          credentialsEnc: encrypt(JSON.stringify(toStored(refreshed, stored.externalId))),
          metadata: { ...(row.metadata as object), needsReauth: false, lastError: null } as unknown as object,
        },
      });
      return refreshed.accessToken;
    } catch (err) {
      // A revoked or rotated grant cannot be recovered without the user.
      await this.markNeedsReauth(organizationId, provider, (err as Error).message);
      return null;
    }
  },

  /** Flag a connection as needing the user to authorise again. */
  async markNeedsReauth(organizationId: string, provider: string, reason: string): Promise<void> {
    const row = await prismaUnscoped.integrationCredential.findUnique({
      where: { organizationId_provider: { organizationId, provider } },
      select: { id: true, metadata: true },
    });
    if (!row) return;
    await prismaUnscoped.integrationCredential.update({
      where: { id: row.id },
      data: { metadata: { ...(row.metadata as object), needsReauth: true, lastError: reason } as unknown as object },
    });
    logger.warn({ organizationId, provider, reason }, 'integration needs re-authorisation');
  },

  /** The externalId captured at connect time (Calendly scopes URIs by it). */
  async externalId(provider: string, organizationId: string): Promise<string | null> {
    const row = await prismaUnscoped.integrationCredential.findUnique({
      where: { organizationId_provider: { organizationId, provider } },
      select: { credentialsEnc: true },
    });
    return row ? readStored(row.credentialsEnc)?.externalId ?? null : null;
  },

  /**
   * Disconnect: tell the provider to forget the grant, then drop the row.
   *
   * The local row goes even if the remote revoke fails — otherwise a provider
   * outage would leave the user unable to disconnect.
   */
  async disconnect(provider: string, organizationId: string): Promise<void> {
    const def = oauthProvider(provider);
    const row = await prismaUnscoped.integrationCredential.findUnique({
      where: { organizationId_provider: { organizationId, provider } },
    });
    if (!row) throw new NotFoundError('Integration connection');

    const stored = readStored(row.credentialsEnc);
    if (def && stored) {
      try {
        await revokeToken(def, stored.refreshToken ?? stored.accessToken);
      } catch (err) {
        logger.warn({ err: (err as Error).message, provider }, 'provider revoke failed; removing locally anyway');
      }
    }
    await prismaUnscoped.integrationCredential.delete({ where: { id: row.id } });
  },

  /** Connection status for the settings screen — never decrypts a secret. */
  async status(provider: string) {
    const row = await prisma.integrationCredential.findFirst({
      where: { provider },
      select: { id: true, provider: true, isActive: true, metadata: true, updatedAt: true },
    });
    return row ?? null;
  },
};
