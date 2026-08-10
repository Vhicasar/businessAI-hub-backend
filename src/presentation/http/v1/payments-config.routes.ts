import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { validate } from '../middleware/validate';
import { requestContext } from '../../../shared/context';
import { prisma } from '../../../infrastructure/database/prisma';
import { ALL_METHODS, METHOD_LABELS } from '../../../infrastructure/payments/capabilities';
import { paymentMethodsService } from '../../../application/payments/payment-methods.service';
import {
  paymentSettingsService,
  paymentSettingsSchema,
} from '../../../application/payments/payment-settings.service';
import { readOrgPaymentAccount, webhookUrlFor } from '../../../application/payments/org-account.service';

/**
 * Business payment configuration (§3).
 *
 * Reads and writes are split by permission on purpose: an accountant needs to
 * see how the business collects, but connecting a gateway means handling
 * credentials, and enabling a method changes what customers are offered
 * everywhere at once.
 */
export const paymentsConfigRoutes = Router();
paymentsConfigRoutes.use(authenticate, requireTenant);

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}

/**
 * The whole picture for the settings screen: what the gateway supports, what
 * the business has switched on, and — for anything unavailable — why.
 */
paymentsConfigRoutes.get(
  '/methods',
  requirePermission('payments.read', 'payments.configure_methods'),
  validate({
    query: z.object({
      currency: z.string().trim().length(3).optional(),
      country: z.string().trim().length(2).optional(),
    }),
  }),
  wrap(async (req, res) => {
    const id = orgId();
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id },
      select: { currency: true, country: true },
    });
    const q = req.query as unknown as { currency?: string; country?: string };
    const resolved = await paymentMethodsService.resolve({
      organizationId: id,
      currency: q.currency ?? org.currency,
      country: q.country ?? org.country,
    });
    const account = await readOrgPaymentAccount(id);
    res.json({
      success: true,
      data: {
        ...resolved,
        // The URL the business pastes into its gateway dashboard. Without this
        // nothing they do in Paystack ever reaches us.
        webhookUrl:
          account?.provider && (account as { webhookId?: string }).webhookId
            ? webhookUrlFor((account as { webhookId?: string }).webhookId!, account.provider)
            : null,
      },
    });
  })
);

const methodSettingSchema = z.object({
  method: z.enum(ALL_METHODS as [string, ...string[]]),
  enabled: z.boolean(),
  currencies: z.array(z.string().trim().length(3)).max(20).optional(),
  instructions: z.string().trim().max(2000).nullable().optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});

/**
 * Switch one method on or off.
 *
 * Takes effect everywhere immediately — there is no cached copy of this in any
 * client, because every surface asks the resolver at render time.
 */
paymentsConfigRoutes.put(
  '/methods/:method',
  requirePermission('payments.configure_methods'),
  validate({ body: methodSettingSchema.omit({ method: true }) }),
  wrap(async (req, res) => {
    const id = orgId();
    const method = String(req.params.method).toUpperCase();
    if (!ALL_METHODS.includes(method as never)) {
      res.status(400).json({ success: false, error: { code: 'UNKNOWN_METHOD' } });
      return;
    }
    const body = req.body as z.infer<typeof methodSettingSchema>;
    const data = {
      enabled: body.enabled,
      currencies: (body.currencies ?? []).map((c) => c.toUpperCase()),
      instructions: body.instructions ?? null,
      sortOrder: body.sortOrder ?? 0,
      updatedById: requestContext.get()?.membershipId ?? null,
    };
    const saved = await prisma.paymentMethodSetting.upsert({
      where: { organizationId_method: { organizationId: id, method: method as never } },
      create: { organizationId: id, method: method as never, ...data },
      update: data,
    });
    res.json({
      success: true,
      message: `${METHOD_LABELS[method as never]} ${body.enabled ? 'enabled' : 'disabled'}.`,
      data: saved,
    });
  })
);

paymentsConfigRoutes.get(
  '/settings',
  requirePermission('payments.read', 'payments.manage_settings'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await paymentSettingsService.get() });
  })
);

paymentsConfigRoutes.put(
  '/settings',
  requirePermission('payments.manage_settings'),
  validate({ body: paymentSettingsSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await paymentSettingsService.save(req.body) });
  })
);
