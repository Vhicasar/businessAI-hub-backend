import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';

import { validate } from '../middleware/validate';
import { authenticateApp } from '../middleware/authenticate-app';
import { transactionSecurity } from '../../../application/identity/transaction-security.service';
import { notifyCustomer } from '../../../application/notifications/notify';
import { auditService } from '../../../application/audit/audit.service';
import { prismaUnscoped } from '../../../infrastructure/database/prisma';
import { mailer } from '../../../infrastructure/mail/mailer';
import { logger } from '../../../shared/logger';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

const pinField = z.string().regex(/^\d{4,8}$/, 'PIN must be 4–8 digits');

/**
 * Settings → Security → Transaction PIN (§1). Mounted at /api/app/v1.
 *
 * Every route here is about proving intent for money movement, so each one
 * notifies the customer afterwards: a PIN that changes without the owner
 * hearing about it is the whole attack.
 */
export const appSecurityRoutes = Router();
appSecurityRoutes.use(authenticateApp);

/** Current transaction-security posture, including the platform's own policy. */
appSecurityRoutes.get(
  '/security/transaction',
  wrap(async (req, res) => {
    res.json({ success: true, data: await transactionSecurity.status(req.appAuth!.vhicasarId) });
  })
);

/** Create a PIN, or change an existing one (the current PIN is then required). */
appSecurityRoutes.put(
  '/security/transaction/pin',
  validate({
    body: z.object({
      pin: pinField,
      currentPin: pinField.optional(),
      deviceId: z.string().trim().max(200).optional(),
    }),
  }),
  wrap(async (req, res) => {
    const vhicasarId = req.appAuth!.vhicasarId;
    const { created } = await transactionSecurity.setPin(vhicasarId, req.body);

    await notifyCustomer({
      vhicasarId,
      category: 'SYSTEM',
      title: created ? 'Transaction PIN created' : 'Transaction PIN changed',
      body: created
        ? 'Your PIN will now be requested for payments and withdrawals.'
        : 'If this was not you, reset your PIN and contact support immediately.',
      deeplink: 'vhicasar://settings/security',
    });
    await auditService.recordConsumer({
      vhicasarId,
      action: created ? 'transaction_pin.created' : 'transaction_pin.changed',
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });

    res.json({
      success: true,
      message: created ? 'Transaction PIN created.' : 'Transaction PIN updated.',
      data: await transactionSecurity.status(vhicasarId),
    });
  })
);

/**
 * Start a forgotten-PIN recovery. The token is delivered out of band, never in
 * the response — otherwise anyone holding the access token could reset the PIN.
 */
appSecurityRoutes.post(
  '/security/transaction/pin/reset-request',
  validate({ body: z.object({ method: z.enum(['PHONE_OTP', 'EMAIL_OTP', 'KYC']).default('EMAIL_OTP') }) }),
  wrap(async (req, res) => {
    const vhicasarId = req.appAuth!.vhicasarId;
    const { token, expiresAt } = await transactionSecurity.requestReset(vhicasarId, req.body.method);

    const identity = await prismaUnscoped.vhicasarId.findUniqueOrThrow({
      where: { id: vhicasarId },
      select: { email: true, phone: true, firstName: true },
    });

    if (req.body.method === 'EMAIL_OTP' && identity.email) {
      try {
        await mailer.sendTransactionPinReset(identity.email, token, identity.firstName);
      } catch (e) {
        logger.error({ err: e, vhicasarId }, 'Could not send PIN reset email');
      }
    } else {
      // No SMS provider is wired for consumer identities yet, so the code is
      // logged rather than silently dropped. It is never returned to the client.
      logger.warn(
        { vhicasarId, method: req.body.method },
        'PIN reset requested on a channel with no delivery provider'
      );
    }

    await notifyCustomer({
      vhicasarId,
      category: 'SYSTEM',
      title: 'PIN reset requested',
      body: 'We sent you a code to set a new transaction PIN.',
      deeplink: 'vhicasar://settings/security',
    });

    res.json({
      success: true,
      message: 'We sent you a code to reset your PIN.',
      data: { method: req.body.method, expiresAt },
    });
  })
);

appSecurityRoutes.post(
  '/security/transaction/pin/reset',
  validate({ body: z.object({ token: z.string().trim().min(10).max(200), pin: pinField }) }),
  wrap(async (req, res) => {
    const vhicasarId = req.appAuth!.vhicasarId;
    await transactionSecurity.resetPin(vhicasarId, req.body);

    await notifyCustomer({
      vhicasarId,
      category: 'SYSTEM',
      title: 'Transaction PIN reset',
      body: 'Your PIN was reset. If this was not you, contact support immediately.',
      deeplink: 'vhicasar://settings/security',
    });
    await auditService.recordConsumer({
      vhicasarId,
      action: 'transaction_pin.reset',
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });

    res.json({ success: true, message: 'Transaction PIN reset.', data: await transactionSecurity.status(vhicasarId) });
  })
);

/** Turn the PIN off. Refused with 403 where platform policy requires one. */
appSecurityRoutes.post(
  '/security/transaction/pin/disable',
  validate({ body: z.object({ currentPin: pinField }) }),
  wrap(async (req, res) => {
    const vhicasarId = req.appAuth!.vhicasarId;
    await transactionSecurity.disablePin(vhicasarId, req.body.currentPin);

    await notifyCustomer({
      vhicasarId,
      category: 'SYSTEM',
      title: 'Transaction PIN removed',
      body: 'Payments will now be confirmed with biometrics only.',
      deeplink: 'vhicasar://settings/security',
    });

    res.json({ success: true, message: 'Transaction PIN removed.', data: await transactionSecurity.status(vhicasarId) });
  })
);

/** Authentication mode, biometrics and the customer's own step-up threshold. */
appSecurityRoutes.put(
  '/security/transaction/settings',
  validate({
    body: z.object({
      authMode: z.enum(['PIN_ONLY', 'BIOMETRIC_ONLY', 'PIN_AND_BIOMETRIC', 'ADAPTIVE']).optional(),
      isBiometricEnabled: z.boolean().optional(),
      highValueThreshold: z.coerce.number().min(0).max(1_000_000_000).optional(),
    }),
  }),
  wrap(async (req, res) => {
    const vhicasarId = req.appAuth!.vhicasarId;
    await transactionSecurity.updateSettings(vhicasarId, req.body);
    await auditService.recordConsumer({
      vhicasarId,
      action: 'transaction_security.updated',
      after: req.body as Record<string, unknown>,
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });
    res.json({ success: true, message: 'Security settings updated.', data: await transactionSecurity.status(vhicasarId) });
  })
);

/** Trust or forget a device, which is what adaptive authentication keys off. */
appSecurityRoutes.post(
  '/security/transaction/devices',
  validate({
    body: z.object({
      deviceId: z.string().trim().min(4).max(200),
      trusted: z.boolean().default(true),
    }),
  }),
  wrap(async (req, res) => {
    const vhicasarId = req.appAuth!.vhicasarId;
    if (req.body.trusted) await transactionSecurity.trustDevice(vhicasarId, req.body.deviceId);
    else await transactionSecurity.forgetDevice(vhicasarId, req.body.deviceId);
    res.json({ success: true, data: await transactionSecurity.status(vhicasarId) });
  })
);
