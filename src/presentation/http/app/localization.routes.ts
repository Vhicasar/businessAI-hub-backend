import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';

import { validate } from '../middleware/validate';
import { authenticateApp } from '../middleware/authenticate-app';
import { localization } from '../../../application/localization/localization.service';
import { notifyCustomer } from '../../../application/notifications/notify';
import { prismaUnscoped } from '../../../infrastructure/database/prisma';
import { CURRENCIES, isSupportedCurrency } from '../../../shared/currency';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

const signalsSchema = z.object({
  gps: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      country: z.string().trim().length(2).optional(),
      region: z.string().trim().max(120).optional(),
      city: z.string().trim().max(120).optional(),
    })
    .optional(),
  simCountry: z.string().trim().length(2).optional(),
  deviceLocale: z.string().trim().max(20).optional(),
  timeZone: z.string().trim().max(60).optional(),
  consentLevel: z.enum(['NONE', 'COARSE', 'PRECISE']).default('NONE'),
});

/**
 * Localization, currency and appearance (§2, §3, §5). Mounted at /api/app/v1.
 *
 * Detection is advisory: everything here resolves *defaults*, and a value the
 * customer set themselves always wins.
 */
export const appLocalizationRoutes = Router();
appLocalizationRoutes.use(authenticateApp);

/**
 * What the app should use right now — country, currency, locale, time zone —
 * plus how it was decided, so the settings screen can say "detected" honestly.
 */
appLocalizationRoutes.post(
  '/localization/resolve',
  validate({ body: signalsSchema.partial().optional() }),
  wrap(async (req, res) => {
    const data = await localization.resolve(
      req.appAuth!.vhicasarId,
      (req.body ?? {}) as Record<string, never>,
      req.headers as Record<string, unknown>
    );
    res.json({ success: true, data });
  })
);

/** Record where the customer is, honouring the consent level they granted. */
appLocalizationRoutes.post(
  '/localization/location',
  validate({ body: signalsSchema }),
  wrap(async (req, res) => {
    const vhicasarId = req.appAuth!.vhicasarId;
    const result = await localization.recordLocation(
      vhicasarId,
      req.body,
      req.headers as Record<string, unknown>
    );

    // Travelling changes what money looks like, so say so rather than silently
    // switching the currency under the customer (§5).
    if (result.countryChanged) {
      await notifyCustomer({
        vhicasarId,
        category: 'SYSTEM',
        title: `Welcome to ${result.resolved.country}`,
        body: `Prices can now be shown in ${result.resolved.currency}. Change this any time in Settings.`,
        deeplink: 'vhicasar://settings/localization',
      });
    }

    res.json({ success: true, data: result });
  })
);

/** Currencies the platform can display, for the picker. */
appLocalizationRoutes.get(
  '/localization/currencies',
  wrap(async (_req, res) => {
    res.json({
      success: true,
      data: { items: CURRENCIES.map((c) => ({ code: c.code, name: c.name, symbol: c.symbol })) },
    });
  })
);

/**
 * Every rate the app needs to render one screen in the customer's chosen
 * currency (§2). One request per screen rather than one per amount, so a list
 * can never show two figures converted at different rates.
 */
appLocalizationRoutes.get(
  '/localization/rates',
  validate({
    query: z.object({
      target: z.string().trim().length(3).toUpperCase(),
      from: z.string().trim().max(200).optional(),
    }),
  }),
  wrap(async (req, res) => {
    const q = req.query as unknown as { target: string; from?: string };
    const sources = q.from?.split(',').map((c) => c.trim()).filter(Boolean);
    res.json({ success: true, data: await localization.ratesInto(q.target, sources) });
  })
);

/**
 * Display-only conversion (§2). Returns the original alongside the converted
 * figure, and says plainly when no rate was available rather than inventing one.
 */
appLocalizationRoutes.get(
  '/localization/convert',
  validate({
    query: z.object({
      amount: z.coerce.number(),
      from: z.string().trim().length(3).toUpperCase(),
      to: z.string().trim().length(3).toUpperCase(),
    }),
  }),
  wrap(async (req, res) => {
    const q = req.query as unknown as { amount: number; from: string; to: string };
    res.json({ success: true, data: await localization.displayAmount(q.amount, q.from, q.to) });
  })
);

/**
 * Appearance and localization preferences (§2, §3).
 *
 * These live on CustomerPreference, which is keyed by Vhicasar ID rather than
 * device — that is what makes the theme follow the customer across devices.
 */
appLocalizationRoutes.put(
  '/localization/preferences',
  validate({
    body: z.object({
      theme: z.enum(['system', 'light', 'dark', 'high_contrast']).optional(),
      locale: z.string().trim().max(10).optional(),
      currency: z.string().trim().length(3).toUpperCase().optional(),
      /** Turn manual currency off and follow detection again. */
      useAutomaticCurrency: z.boolean().optional(),
      showOriginalCurrency: z.boolean().optional(),
      exchangeRateSource: z.string().trim().max(40).optional(),
    }),
  }),
  wrap(async (req, res) => {
    const vhicasarId = req.appAuth!.vhicasarId;
    const body = req.body as {
      theme?: string;
      locale?: string;
      currency?: string;
      useAutomaticCurrency?: boolean;
      showOriginalCurrency?: boolean;
      exchangeRateSource?: string;
    };

    if (body.currency && !isSupportedCurrency(body.currency)) {
      res.status(400).json({
        success: false,
        error: { code: 'UNSUPPORTED_CURRENCY', message: `${body.currency} is not supported yet.` },
      });
      return;
    }

    const before = await prismaUnscoped.customerPreference.findUnique({ where: { vhicasarId } });

    // Display options that have no column of their own ride in the JSON blob,
    // so adding one never needs a migration.
    const existingNotif = (before?.notificationPreferences as Record<string, unknown> | null) ?? {};
    const display = {
      ...((existingNotif.display as Record<string, unknown>) ?? {}),
      ...(body.useAutomaticCurrency !== undefined ? { useAutomaticCurrency: body.useAutomaticCurrency } : {}),
      ...(body.showOriginalCurrency !== undefined ? { showOriginalCurrency: body.showOriginalCurrency } : {}),
      ...(body.exchangeRateSource ? { exchangeRateSource: body.exchangeRateSource } : {}),
    };

    const data = {
      ...(body.theme ? { theme: body.theme } : {}),
      ...(body.locale ? { locale: body.locale } : {}),
      // "Automatic" means: stop pinning a currency and let detection decide.
      ...(body.useAutomaticCurrency === true
        ? {}
        : body.currency
          ? { currency: body.currency }
          : {}),
      notificationPreferences: { ...existingNotif, display },
    };

    const saved = await prismaUnscoped.customerPreference.upsert({
      where: { vhicasarId },
      create: { vhicasarId, ...data },
      update: data,
    });

    if (body.currency && body.currency !== before?.currency) {
      await notifyCustomer({
        vhicasarId,
        category: 'SYSTEM',
        title: 'Display currency updated',
        body: `Amounts will now be shown in ${body.currency}.`,
        deeplink: 'vhicasar://settings/localization',
      });
    }
    if (body.theme && body.theme !== before?.theme) {
      await notifyCustomer({
        vhicasarId,
        category: 'SYSTEM',
        title: 'Appearance updated',
        body: `Your theme is now "${body.theme}" on every device you sign in to.`,
        deeplink: 'vhicasar://settings/localization',
      });
    }

    res.json({ success: true, message: 'Preferences updated.', data: saved });
  })
);
