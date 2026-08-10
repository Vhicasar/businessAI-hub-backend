import type { PaymentMethodKind } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import {
  ALL_METHODS,
  METHOD_LABELS,
  PLATFORM_NATIVE_METHODS,
  PROVIDER_CAPABILITIES,
  type ProviderMethodSupport,
} from '../../infrastructure/payments/capabilities';
import type { PaymentProviderName } from '../../infrastructure/payments';
import { AppError } from '../../shared/errors';
import { readOrgPaymentAccount } from './org-account.service';

/**
 * The one place that answers "what can this customer pay with?".
 *
 * Every surface — the hosted pay page, the customer app, the business app,
 * inbox chat, the AI, payment links, QR codes and the public API — calls this
 * and renders what it returns. None of them keeps its own list, which is what
 * makes a business toggling a method take effect everywhere at once (§22).
 *
 * The hierarchy is strict and each layer can only ever subtract:
 *
 *     Platform supported          what the code can represent at all
 *            ↓
 *     Provider supported          what the connected gateway will collect,
 *                                 for this currency and country
 *            ↓
 *     Business enabled            what the business has switched on
 *            ↓
 *     Customer available          what is finally offered
 *
 * An operator can restrict a provider platform-wide, but nothing here lets an
 * operator switch on a method a business has switched off (§18).
 */

export interface AvailableMethod {
  method: PaymentMethodKind;
  label: string;
  /** Business's own copy for this method, shown on the payment page. */
  instructions: string | null;
  sortOrder: number;
}

export interface MethodAvailability {
  method: PaymentMethodKind;
  label: string;
  available: boolean;
  /** Why it is not on offer. Null when it is. */
  reason:
    | null
    | 'NO_PROVIDER'
    | 'PROVIDER_UNSUPPORTED'
    | 'PLATFORM_DISABLED'
    | 'CURRENCY_UNSUPPORTED'
    | 'COUNTRY_UNSUPPORTED'
    | 'AMOUNT_OUT_OF_RANGE'
    | 'BUSINESS_DISABLED';
  instructions: string | null;
  sortOrder: number;
}

export interface ResolveInput {
  organizationId: string;
  currency: string;
  /** ISO-2. Falls back to the organization's own country. */
  country?: string | null;
  /** Some methods are only offered inside a size band (USSD ceilings). */
  amount?: number | null;
}

export interface ResolvedMethods {
  /** Adapter key of the gateway that would collect, or null if none connected. */
  provider: PaymentProviderName | null;
  providerConnected: boolean;
  currency: string;
  country: string | null;
  /** Ready to render, in the business's chosen order. */
  available: AvailableMethod[];
  /** Every method with a verdict — for settings screens and the AI, not customers. */
  all: MethodAvailability[];
}

/** Empty means "no restriction". */
function listAllows(list: string[] | undefined, value: string | null | undefined): boolean {
  if (!list || list.length === 0) return true;
  if (!value) return false;
  return list.includes(value.toUpperCase());
}

function capabilityFor(
  provider: PaymentProviderName | null,
  method: PaymentMethodKind
): ProviderMethodSupport | undefined {
  const native = PLATFORM_NATIVE_METHODS.find((m) => m.method === method);
  if (native) return native;
  if (!provider) return undefined;
  return PROVIDER_CAPABILITIES[provider]?.find((m) => m.method === method);
}

/**
 * Operator overrides, layered over the shipped defaults.
 *
 * Read unscoped: capabilities are platform-level and this runs in the public
 * pay flow where there is no tenant in context.
 */
async function operatorOverrides(provider: string | null) {
  if (!provider) return new Map<PaymentMethodKind, { enabled: boolean; cap: ProviderMethodSupport }>();
  const rows = await prismaUnscoped.providerCapability.findMany({ where: { provider } });
  return new Map(
    rows.map((r) => [
      r.method,
      {
        enabled: r.enabled,
        cap: {
          method: r.method,
          currencies: r.currencies,
          countries: r.countries,
          minAmount: r.minAmount ? Number(r.minAmount) : undefined,
          maxAmount: r.maxAmount ? Number(r.maxAmount) : undefined,
        } satisfies ProviderMethodSupport,
      },
    ])
  );
}

export const paymentMethodsService = {
  /**
   * Resolve what is on offer. Takes an explicit organization id rather than
   * reading the request context, because the public pay page and provider
   * webhooks have no tenant in context.
   */
  async resolve(input: ResolveInput): Promise<ResolvedMethods> {
    const currency = input.currency.toUpperCase();

    const [org, account, settings] = await Promise.all([
      prismaUnscoped.organization.findUnique({
        where: { id: input.organizationId },
        select: { country: true },
      }),
      readOrgPaymentAccount(input.organizationId),
      prismaUnscoped.paymentMethodSetting.findMany({
        where: { organizationId: input.organizationId },
      }),
    ]);

    const country = (input.country ?? org?.country ?? null)?.toUpperCase() ?? null;
    // A gateway only counts as connected when it is enabled AND has a secret
    // on file — keys alone collect nothing.
    const providerConnected = Boolean(account?.enabled && account.hasSecretKey);
    const provider = providerConnected ? (account!.provider as PaymentProviderName) : null;

    const overrides = await operatorOverrides(provider);
    const byMethod = new Map(settings.map((s) => [s.method, s]));

    const all: MethodAvailability[] = ALL_METHODS.map((method) => {
      const setting = byMethod.get(method);
      const label = METHOD_LABELS[method];
      const instructions = setting?.instructions ?? null;
      const sortOrder = setting?.sortOrder ?? ALL_METHODS.indexOf(method);
      const base = { method, label, instructions, sortOrder };

      const isNative = PLATFORM_NATIVE_METHODS.some((m) => m.method === method);
      if (!isNative && !provider) {
        return { ...base, available: false, reason: 'NO_PROVIDER' as const };
      }

      const shipped = capabilityFor(provider, method);
      const override = overrides.get(method);
      if (!shipped && !override) {
        return { ...base, available: false, reason: 'PROVIDER_UNSUPPORTED' as const };
      }
      if (override && !override.enabled) {
        return { ...base, available: false, reason: 'PLATFORM_DISABLED' as const };
      }

      // An operator row, where present, replaces the shipped defaults entirely
      // so a correction is not silently unioned with a stale default.
      const cap = override?.cap ?? shipped!;

      if (!listAllows(cap.currencies, currency)) {
        return { ...base, available: false, reason: 'CURRENCY_UNSUPPORTED' as const };
      }
      if (!listAllows(cap.countries, country)) {
        return { ...base, available: false, reason: 'COUNTRY_UNSUPPORTED' as const };
      }
      if (input.amount != null) {
        if (cap.minAmount != null && input.amount < cap.minAmount) {
          return { ...base, available: false, reason: 'AMOUNT_OUT_OF_RANGE' as const };
        }
        if (cap.maxAmount != null && input.amount > cap.maxAmount) {
          return { ...base, available: false, reason: 'AMOUNT_OUT_OF_RANGE' as const };
        }
      }

      // The business has the last word. No row means "not chosen yet", which
      // is off: a business must opt in to taking money a particular way rather
      // than discover it is already doing so.
      if (!setting?.enabled) {
        return { ...base, available: false, reason: 'BUSINESS_DISABLED' as const };
      }
      // A method may be enabled for some currencies only.
      if (!listAllows(setting.currencies, currency)) {
        return { ...base, available: false, reason: 'CURRENCY_UNSUPPORTED' as const };
      }

      return { ...base, available: true, reason: null };
    });

    const available = all
      .filter((m) => m.available)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label))
      .map(({ method, label, instructions, sortOrder }) => ({
        method,
        label,
        instructions,
        sortOrder,
      }));

    return { provider, providerConnected, currency, country, available, all };
  },

  /**
   * Guard for the moment a customer commits to a method.
   *
   * The list they were shown may be minutes old and the business may have
   * turned the method off since. Anything that acts on a chosen method calls
   * this rather than trusting what the client sends back.
   */
  async assertAvailable(input: ResolveInput & { method: PaymentMethodKind }): Promise<void> {
    const resolved = await this.resolve(input);
    if (!resolved.available.some((m) => m.method === input.method)) {
      const verdict = resolved.all.find((m) => m.method === input.method);
      throw new AppError(
        'PAYMENT_METHOD_UNAVAILABLE',
        409,
        `${METHOD_LABELS[input.method]} is not available for this payment.`,
        { reason: verdict?.reason ?? 'BUSINESS_DISABLED' }
      );
    }
  },
};
