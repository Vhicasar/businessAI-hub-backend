import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { logger } from '../../shared/logger';
import { env } from '../../shared/config/env';
import { decrypt } from '../../shared/crypto';
import { NotFoundError } from '../../shared/errors';
import type { MetaErrorDetail } from '../../infrastructure/channels/meta-error';

/**
 * Whether Meta will let this business send paid WhatsApp messages.
 *
 * The honest answer is usually "we cannot know". Meta publishes no Graph API
 * field for payment-method status — a WhatsApp Business Account exposes
 * `account_review_status`, `business_verification_status` and a handful of
 * profile fields, and none of them says whether a card is attached. The only
 * reliable indicator Meta gives is error 131042 in response to an actual
 * send.
 *
 * So this service does not pretend to a certainty it cannot have. It records
 * what Meta has actually told us, reports UNKNOWN rather than guessing, and
 * never claims setup succeeded because somebody clicked a link.
 *
 * Inbound messaging is deliberately untouched by any of this: a business that
 * has not set up billing must still be able to receive and answer messages.
 */
export type BillingState =
  /** Meta refused a send for payment reasons. Campaigns must stop. */
  | 'BILLING_REQUIRED'
  /** A paid message went through, so billing worked at least once. */
  | 'READY'
  /** Nothing has been sent yet, or nothing conclusive has come back. */
  | 'UNKNOWN';

export interface BillingStatus {
  state: BillingState;
  /** When Meta last told us something conclusive. */
  changedAt: string | null;
  /** When readiness was last actively probed. */
  checkedAt: string | null;
  /** Meta's review status, when we could read it. Informational only. */
  reviewStatus: string | null;
  /** Meta's code for the refusal, kept so support can match it to the docs. */
  metaCode: number | null;
  /** What to tell the business. Null when there is nothing to say. */
  message: string | null;
  /** Where the business completes setup, per Meta's own documentation. */
  setupUrl: string;
  billingHubUrl: string;
  wabaId: string | null;
  wabaName: string | null;
}

interface StoredBilling {
  state?: BillingState;
  changedAt?: string;
  checkedAt?: string;
  reviewStatus?: string | null;
  metaCode?: number | null;
}

/*
 * Meta's documented destinations, used exactly as documented.
 *
 * The Tech Provider onboarding guide sends customers to WhatsApp Manager's
 * Overview panel to click "Add payment method", and the billing panel lives at
 * the Billing Hub root. Neither is documented as accepting a WABA id, so no
 * deep-link parameter is invented here — the account is named in the UI
 * instead, so the business picks the right one when they arrive.
 */
const WHATSAPP_MANAGER_URL = 'https://business.facebook.com/wa/manage/home/';
const BILLING_HUB_URL = 'https://business.facebook.com/billing_hub/';

const BILLING_MESSAGE =
  'Your WhatsApp account is connected, but Meta needs a payment method before it will send this campaign. '
  + 'Meta bills its messaging charges separately from your Vhicasar subscription.';

function readBilling(metadata: unknown): StoredBilling {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const billing = (metadata as { billing?: unknown }).billing;
  return billing && typeof billing === 'object' && !Array.isArray(billing) ? billing as StoredBilling : {};
}

async function loadAccount(accountId: string, organizationId: string) {
  const account = await prismaUnscoped.channelAccount.findFirst({
    where: { id: accountId, organizationId, channelType: 'WHATSAPP', deletedAt: null },
    select: { id: true, organizationId: true, name: true, metadata: true, credentialsEnc: true },
  });
  // Scoped by organizationId in the query itself: a campaign must never be
  // able to read another business's WhatsApp account by guessing an id.
  if (!account) throw new NotFoundError('WhatsApp channel');
  return account;
}

async function writeBilling(accountId: string, patch: StoredBilling): Promise<void> {
  const row = await prismaUnscoped.channelAccount.findUnique({
    where: { id: accountId }, select: { metadata: true },
  });
  const metadata = (row?.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata))
    ? row.metadata as Record<string, unknown>
    : {};
  const billing = { ...readBilling(metadata), ...patch };
  await prismaUnscoped.channelAccount
    .update({ where: { id: accountId }, data: { metadata: { ...metadata, billing } as object } })
    .catch((err) => logger.warn({ err, accountId }, 'Could not record WhatsApp billing state'));
}

export const whatsappBillingService = {
  /**
   * What we currently believe, without contacting Meta.
   *
   * Cheap enough to call on any screen that needs to decide whether to show a
   * billing prompt, which matters because the prompt must not appear on every
   * screen for an unresolved issue.
   */
  async status(accountId: string, organizationId: string): Promise<BillingStatus> {
    const account = await loadAccount(accountId, organizationId);
    const metadata = (account.metadata ?? {}) as Record<string, unknown>;
    const billing = readBilling(metadata);
    const state = billing.state ?? 'UNKNOWN';
    return {
      state,
      changedAt: billing.changedAt ?? null,
      checkedAt: billing.checkedAt ?? null,
      reviewStatus: billing.reviewStatus ?? null,
      metaCode: billing.metaCode ?? null,
      message: state === 'BILLING_REQUIRED' ? BILLING_MESSAGE : null,
      setupUrl: WHATSAPP_MANAGER_URL,
      billingHubUrl: BILLING_HUB_URL,
      wabaId: typeof metadata.wabaId === 'string' ? metadata.wabaId : null,
      wabaName: typeof metadata.wabaName === 'string' ? metadata.wabaName : account.name,
    };
  },

  /**
   * Ask Meta what it will tell us, which is less than anyone would like.
   *
   * `account_review_status` is a documented WABA field and is read here
   * because a rejected account explains a refusal the business would
   * otherwise blame on billing. It is not a payment check and is never
   * reported as one: a healthy review status leaves the state UNKNOWN rather
   * than promoting it to READY.
   */
  async check(accountId: string, organizationId: string): Promise<BillingStatus> {
    const account = await loadAccount(accountId, organizationId);
    const metadata = (account.metadata ?? {}) as Record<string, unknown>;
    const wabaId = typeof metadata.wabaId === 'string' ? metadata.wabaId : null;
    let reviewStatus: string | null = null;

    if (wabaId && account.credentialsEnc) {
      try {
        const credentials = JSON.parse(decrypt(account.credentialsEnc)) as { accessToken?: string };
        if (credentials.accessToken) {
          const res = await fetch(
            `${env.meta.graphUrl}/${wabaId}?fields=account_review_status`,
            { headers: { Authorization: `Bearer ${credentials.accessToken}` }, signal: AbortSignal.timeout(8_000) },
          );
          const json = (await res.json().catch(() => ({}))) as { account_review_status?: string };
          if (res.ok && typeof json.account_review_status === 'string') reviewStatus = json.account_review_status;
        }
      } catch (err) {
        // A probe that fails tells us nothing new; it must not change state.
        logger.warn({ err, accountId }, 'WhatsApp account review probe failed');
      }
    }

    await writeBilling(accountId, { checkedAt: new Date().toISOString(), reviewStatus });
    const status = await this.status(accountId, organizationId);
    return { ...status, reviewStatus };
  },

  /**
   * Meta refused a send for payment reasons. This is the conclusive signal.
   */
  async markBillingRequired(accountId: string, detail: MetaErrorDetail): Promise<void> {
    await writeBilling(accountId, {
      state: 'BILLING_REQUIRED',
      changedAt: new Date().toISOString(),
      metaCode: detail.code,
    });
    logger.warn({ accountId, metaCode: detail.code, metaSubcode: detail.subcode }, 'WhatsApp billing setup required by Meta');
  },

  /**
   * A paid message went through, so whatever was wrong is no longer wrong.
   * Called on a successful template send rather than on a button click,
   * because clicking a link to Meta proves nothing.
   */
  async markReady(accountId: string): Promise<void> {
    const account = await prismaUnscoped.channelAccount.findUnique({
      where: { id: accountId }, select: { metadata: true },
    });
    const current = readBilling(account?.metadata).state ?? 'UNKNOWN';
    if (current === 'READY') return;   // already known good; no write per message
    await writeBilling(accountId, { state: 'READY', changedAt: new Date().toISOString(), metaCode: null });
    logger.info({ accountId }, 'WhatsApp paid messaging confirmed working');
  },
};
