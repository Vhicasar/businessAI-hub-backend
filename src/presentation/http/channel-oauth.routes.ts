import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { ChannelType } from '@prisma/client';
import { requestContext } from '../../shared/context';
import { randomUUID } from 'crypto';
import { env } from '../../shared/config/env';
import { AppError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import {
  completeCallback,
  subscribeWebhooks,
} from '../../application/inbox/channel-oauth.service';
import { channelsService } from '../../application/inbox/channels.service';
import { markChannelError } from '../../application/inbox/channel-health.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/**
 * Where the provider sends the browser back after authorisation.
 *
 * Deliberately outside the authenticated API: this is a plain redirect from
 * Meta and carries no session cookie or bearer token of ours. What makes it
 * safe is the signed `state` — it names the tenant, cannot be forged without
 * the signing key, and expires after ten minutes, so a stolen or replayed
 * callback URL cannot attach an account to somebody else's business.
 *
 * Every path ends in a redirect back into the app. This URL is in the user's
 * address bar, so a JSON error body would be the entire experience of a
 * failure.
 */
export const channelOAuthRoutes = Router();

channelOAuthRoutes.get(
  '/:channel/callback',
  wrap(async (req, res) => {
    const channelType = String(req.params.channel).toUpperCase() as ChannelType;
    const settings = `${env.WEB_APP_URL}/settings/integrations?tab=channels`;
    const fail = (message: string) => {
      res.redirect(`${settings}&connect=error&reason=${encodeURIComponent(message)}`);
    };

    // The user pressed Cancel on the provider's dialog, or it refused outright.
    if (typeof req.query.error === 'string') {
      fail(
        typeof req.query.error_description === 'string'
          ? req.query.error_description
          : 'The connection was cancelled.'
      );
      return;
    }

    const code = req.query.code;
    const state = req.query.state;
    if (typeof code !== 'string' || typeof state !== 'string') {
      fail('That connection link was incomplete. Please try connecting again.');
      return;
    }

    try {
      const connection = await completeCallback({ channelType, code, state });

      // Bind the tenant the signed state named, so everything below is
      // auto-scoped to the business that actually started this flow.
      const account = await requestContext.run(
        {
          requestId: randomUUID(),
          organizationId: connection.organizationId,
          userId: connection.userId,
        },
        () => channelsService.connectFromOAuth(connection)
      );

      /*
       * Subscribing is what makes messages actually arrive. Done after the
       * account exists so a failure leaves something to retry against rather
       * than losing the token entirely.
       *
       * A failure here is recorded on the channel before it is re-thrown: the
       * account is authorised but deaf, and leaving it reading CONNECTED would
       * be the worst of both — the business sees a healthy channel and waits
       * for messages that can never arrive.
       */
      try {
        await subscribeWebhooks(connection);
      } catch (subscribeError) {
        await markChannelError(
          account.id,
          channelType,
          `Webhook subscription failed: ${(subscribeError as Error).message}`,
        );
        throw subscribeError;
      }

      res.redirect(
        `${settings}&connect=success&channel=${channelType.toLowerCase()}` +
          `&account=${encodeURIComponent(account.name)}`
      );
    } catch (err) {
      // The full provider error goes to the log; the user gets a sentence they
      // can act on.
      logger.warn(
        { err, channelType, message: (err as Error).message },
        'Channel OAuth callback failed'
      );
      fail(
        err instanceof AppError
          ? err.message
          : 'We could not finish connecting that account. Please try again.'
      );
    }
  })
);
