import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { fcm, type PushPayload } from '../../infrastructure/push/fcm';
import { logger } from '../../shared/logger';

/**
 * Push notifications for the Customer Super App.
 *
 * The business app pushes to `DeviceToken` (keyed by User); consumers live on
 * `Device` (keyed by Vhicasar ID), so this is the consumer-side equivalent.
 * Dead tokens are pruned from the device record so a reinstalled app doesn't
 * accumulate stale endpoints.
 */
export const consumerPush = {
  async sendToIdentity(vhicasarId: string, payload: PushPayload): Promise<void> {
    if (!fcm.enabled) return;
    const devices = await prismaUnscoped.device.findMany({
      where: { vhicasarId, revokedAt: null, pushToken: { not: null } },
      select: { id: true, pushToken: true },
    });
    const tokens = devices.map((d) => d.pushToken).filter((t): t is string => Boolean(t));
    if (tokens.length === 0) return;

    try {
      const res = await fcm.sendToTokens(tokens, payload);
      if (res.invalidTokens.length > 0) {
        await prismaUnscoped.device.updateMany({
          where: { pushToken: { in: res.invalidTokens } },
          data: { pushToken: null },
        });
      }
    } catch (err) {
      // Never let a push failure break the business action that triggered it.
      logger.error({ err, vhicasarId }, 'consumer push failed');
    }
  },
};
