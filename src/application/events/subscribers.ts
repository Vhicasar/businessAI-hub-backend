import { eventBus } from '../../shared/event-bus';
import { logger } from '../../shared/logger';
import { consumerPush } from '../notifications/consumer-push.service';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { webhookDelivery } from '../api-keys/webhook-delivery.service';
import { rewardsService } from '../rewards/rewards.service';
import { loyaltyEngine } from '../loyalty/loyalty-engine.service';
import { rewardCampaigns } from '../rewards/reward-campaign.service';
import { notifyCustomer } from '../superapp/customer-search.service';
import { broadcast } from '../../infrastructure/realtime/live-events';
import { SOCKET_EVENTS } from '../../shared/events';

/**
 * Registers the platform's core domain-event subscribers. Modules add their own
 * by calling `eventBus.on(...)`. This is the single place wiring cross-module
 * reactions (System Bible II §9) — e.g. PaymentCompleted → push, loyalty,
 * outbound webhooks.
 */

type Payload = Record<string, unknown>;

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Human-readable money for a notification body. */
function formatAmount(amount: unknown, currency: unknown): string {
  const n = Number(amount);
  const cur = typeof currency === 'string' ? currency : '';
  if (!Number.isFinite(n)) return cur.trim();
  return `${cur} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();
}

export function registerCoreSubscribers(): void {
  // Tracing: a single sink that observes every domain event.
  eventBus.onAny((event) => {
    logger.debug({ event: event.name, aggregate: `${event.aggregateType}:${event.aggregateId}`, org: event.organizationId }, 'domain event');
  });

  // Financial + fraud events worth surfacing at info level for observability.
  const notable = new Set([
    'PaymentCompleted',
    'TransactionBlocked',
    'FraudAlertCreated',
    'SettlementCreated',
    'ShiftClosed',
    'PayoutPaid',
    'PayoutFailed',
  ]);
  eventBus.onAny((event) => {
    if (notable.has(event.name)) {
      logger.info({ event: event.name, org: event.organizationId, payload: event.payload }, 'notable domain event');
    }
  });

  // ---- Live updates (F3) ----
  // Money events reach open screens the moment they happen, so no balance,
  // order or settlement waits for a manual refresh. Registered on the event bus
  // rather than at each call site, so a new money path is live automatically.
  const LIVE_EVENTS: Record<string, string> = {
    PaymentCompleted: SOCKET_EVENTS.PAYMENT_RECEIVED,
    PaymentFailed: SOCKET_EVENTS.PAYMENT_STATUS_CHANGED,
    RefundProcessed: SOCKET_EVENTS.PAYMENT_STATUS_CHANGED,
    TransactionBlocked: SOCKET_EVENTS.PAYMENT_STATUS_CHANGED,
    WalletCredited: SOCKET_EVENTS.WALLET_UPDATED,
    WalletDebited: SOCKET_EVENTS.WALLET_UPDATED,
    PayoutPaid: SOCKET_EVENTS.WALLET_UPDATED,
    PayoutFailed: SOCKET_EVENTS.WALLET_UPDATED,
    SettlementCreated: SOCKET_EVENTS.SETTLEMENT_UPDATED,
    SettlementPaid: SOCKET_EVENTS.SETTLEMENT_UPDATED,
    SettlementFailed: SOCKET_EVENTS.SETTLEMENT_UPDATED,
  };

  eventBus.onAny((event) => {
    const socketEvent = LIVE_EVENTS[event.name];
    if (!socketEvent) return;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    try {
      broadcast({
        event: socketEvent,
        payload: {
          domainEvent: event.name,
          aggregateId: event.aggregateId,
          ...payload,
        },
        organizationId: event.organizationId,
        // The customer's own id when the event carries one, so their app
        // updates too rather than only the merchant's dashboard.
        vhicasarId: (payload.vhicasarId as string | undefined) ?? null,
      });
    } catch (err) {
      // A live update failing must never break the thing that caused it.
      logger.debug({ err, event: event.name }, 'live broadcast failed');
    }
  });

  // ---- Outbound webhooks (API Bible §13) ----
  // Domain event name → public webhook event name. Only mapped events are
  // deliverable, so internal events never leak to third parties by accident.
  const WEBHOOK_MAP: Record<string, string> = {
    PaymentCompleted: 'payment.completed',
    RefundProcessed: 'payment.refunded',
    TransactionBlocked: 'payment.blocked',
    WalletCredited: 'wallet.credited',
    WalletDebited: 'wallet.debited',
    PayoutPaid: 'payout.paid',
    PayoutFailed: 'payout.failed',
    SettlementCreated: 'settlement.created',
    CustomerLinked: 'customer.linked',
    CustomerCreated: 'customer.created',
    OrderCreated: 'order.created',
    BookingConfirmed: 'booking.confirmed',
    LoyaltyAwarded: 'loyalty.awarded',
    PropertyListed: 'property.listed',
    FraudAlertCreated: 'fraud.alert_created',
    ShiftClosed: 'shift.closed',
  };

  eventBus.onAny(async (event) => {
    const publicName = WEBHOOK_MAP[event.name];
    // Webhooks are per-tenant; a platform-global event has no subscriber to
    // deliver to.
    if (!publicName || !event.organizationId) return;
    await webhookDelivery.dispatch(event.organizationId, publicName, {
      ...(event.payload as Record<string, unknown>),
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      occurredAt: event.occurredAt,
    });
  });

  // ---- Universal rewards: every Vhicasar Pay payment earns cross-business points ----
  eventBus.on('PaymentCompleted', async (event) => {
    const p = (event.payload ?? {}) as Payload;
    const vhicasarId = asString(p.vhicasarId);
    const paymentId = asString(p.paymentId);
    if (!vhicasarId || !paymentId) return;
    await rewardsService.earnForPayment({
      vhicasarId,
      organizationId: event.organizationId,
      paymentId,
      amount: String(p.amount ?? '0'),
      currency: String(p.currency ?? 'NGN'),
    });
  });

  // ---- Business loyalty: ANY qualifying event earns points (§5) ----
  // Loyalty is not tied to a payment rail; each event maps to its own trigger
  // and the business's rules decide whether anything is awarded.
  const LOYALTY_TRIGGERS: Record<string, 'POS_SALE' | 'ORDER' | 'BOOKING' | 'INVOICE_PAYMENT' | 'WALLET_PAYMENT'> = {
    SaleCompleted: 'POS_SALE',
    OrderCompleted: 'ORDER',
    BookingConfirmed: 'BOOKING',
    InvoicePaid: 'INVOICE_PAYMENT',
  };

  eventBus.onAny(async (event) => {
    const trigger = LOYALTY_TRIGGERS[event.name];
    if (!trigger || !event.organizationId) return;
    const p = (event.payload ?? {}) as Payload;
    const customerId = asString(p.customerId);
    if (!customerId) return;
    await loyaltyEngine.award({
      organizationId: event.organizationId,
      customerId,
      trigger,
      amount: (p.amount ?? p.total) as string | number | undefined,
      currency: asString(p.currency),
      branchId: asString(p.branchId) ?? null,
      sourceType: event.aggregateType,
      sourceId: event.aggregateId,
    });
  });

  // Vhicasar Pay is just one more trigger. The payload identifies the payer by
  // Vhicasar ID, so resolve the business's own customer record through the link
  // — business points belong to that record, not the global identity.
  eventBus.on('PaymentCompleted', async (event) => {
    const p = (event.payload ?? {}) as Payload;
    if (!event.organizationId) return;
    let customerId = asString(p.customerId);
    const vhicasarId = asString(p.vhicasarId);
    if (!customerId && vhicasarId) {
      const link = await prismaUnscoped.customerLink.findUnique({
        where: { vhicasarId_organizationId: { vhicasarId, organizationId: event.organizationId } },
        select: { customerId: true },
      });
      customerId = link?.customerId;
    }
    if (!customerId) return;
    await loyaltyEngine.award({
      organizationId: event.organizationId,
      customerId,
      trigger: 'WALLET_PAYMENT',
      amount: asString(p.amount),
      currency: asString(p.currency),
      sourceType: 'Payment',
      sourceId: asString(p.paymentId) ?? event.aggregateId,
    });
  });

  // ---- Platform reward campaigns: pay customers for paying with the app ----
  eventBus.on('PaymentCompleted', async (event) => {
    const p = (event.payload ?? {}) as Payload;
    const vhicasarId = asString(p.vhicasarId);
    const paymentId = asString(p.paymentId);
    if (!vhicasarId || !paymentId) return;
    await rewardCampaigns.grantForPayment({
      vhicasarId,
      organizationId: event.organizationId,
      paymentId,
      amount: asString(p.amount) ?? '0',
      currency: asString(p.currency) ?? 'NGN',
      deviceId: asString(p.deviceId),
    });
  });

  // ---- Business-created records reach the customer (§8) ----
  // When staff raise an order or invoice for someone, that person should hear
  // about it and be able to pay from the notification — not discover it later.
  const PAYABLE_CREATED: Record<string, { kind: 'ORDER' | 'INVOICE'; label: string }> = {
    OrderCreated: { kind: 'ORDER', label: 'order' },
    InvoiceIssued: { kind: 'INVOICE', label: 'invoice' },
  };

  eventBus.onAny(async (event) => {
    const mapping = PAYABLE_CREATED[event.name];
    if (!mapping || !event.organizationId) return;
    const p = (event.payload ?? {}) as Payload;
    const customerId = asString(p.customerId);
    if (!customerId) return;

    const link = await prismaUnscoped.customerLink.findFirst({
      where: { customerId, status: 'ACTIVE' },
      select: { vhicasarId: true, organizationId: true },
    });
    // No Vhicasar account yet — nothing to notify. The record still waits for
    // them if they join later.
    if (!link) return;

    const org = await prismaUnscoped.organization.findUnique({
      where: { id: event.organizationId },
      select: { name: true },
    });
    const amount = asString(p.total) ?? asString(p.amount);

    await consumerPush.sendToIdentity(link.vhicasarId, {
      title: `${org?.name ?? 'A business'} raised an ${mapping.label}`,
      body: amount != null
        ? `${formatAmount(amount, p.currency)} — tap to view and pay.`
        : 'Tap to view the details.',
      data: {
        type: mapping.kind === 'ORDER' ? 'order' : 'invoice',
        organizationId: event.organizationId,
        recordId: event.aggregateId,
        // Opens the right business, then the right record (§8).
        deeplink: `vhicasar://business/${event.organizationId}/${mapping.kind.toLowerCase()}/${event.aggregateId}`,
      },
    });
  });

  // ---- Customer Super App notifications ----
  //
  // Push can fail or be switched off; the in-app feed is the record the
  // customer can always come back to. So every consumer-facing event writes a
  // CustomerNotification alongside the push, categorised for the grouped feed.
  const FEED: Record<
    string,
    { category: 'ORDER' | 'PAYMENT' | 'PROMOTION' | 'BOOKING' | 'REWARD' | 'SUPPORT' | 'DOCUMENT' | 'SYSTEM'; title: string }
  > = {
    PaymentCompleted: { category: 'PAYMENT', title: 'Payment successful' },
    WalletCredited: { category: 'PAYMENT', title: 'Wallet funded' },
    WalletDebited: { category: 'PAYMENT', title: 'Wallet debited' },
    TransactionBlocked: { category: 'SUPPORT', title: 'Payment blocked' },
    PayoutPaid: { category: 'PAYMENT', title: 'Withdrawal sent' },
    PayoutFailed: { category: 'PAYMENT', title: 'Withdrawal failed' },
    KycReviewed: { category: 'SYSTEM', title: 'Identity verification' },
    RewardEarned: { category: 'REWARD', title: 'Points earned' },
    RewardGranted: { category: 'REWARD', title: 'Cashback received' },
    LoyaltyAwarded: { category: 'REWARD', title: 'Loyalty points earned' },
    BookingCancelled: { category: 'BOOKING', title: 'Booking cancelled' },
    OrderCreated: { category: 'ORDER', title: 'New order' },
  };

  eventBus.onAny(async (event) => {
    const mapping = FEED[event.name];
    if (!mapping) return;
    const p = (event.payload ?? {}) as Payload;

    // Resolve the customer: some events carry the identity, others only the
    // business's own customer record.
    let vhicasarId = asString(p.vhicasarId);
    if (!vhicasarId) {
      const customerId = asString(p.customerId);
      if (!customerId) return;
      const link = await prismaUnscoped.customerLink.findFirst({
        where: { customerId, status: 'ACTIVE' },
        select: { vhicasarId: true },
      });
      vhicasarId = link?.vhicasarId;
    }
    if (!vhicasarId) return;

    const amount = asString(p.amount);
    await notifyCustomer({
      vhicasarId,
      organizationId: event.organizationId,
      category: mapping.category,
      title: mapping.title,
      body: amount ? formatAmount(amount, p.currency) : undefined,
      data: {
        eventName: event.name,
        aggregateId: event.aggregateId,
        deeplink: event.organizationId
          ? `vhicasar://business/${event.organizationId}`
          : 'vhicasar://wallet',
      },
    });
  });

  // ---- Customer Super App push notifications ----

  eventBus.on('PaymentCompleted', async (event) => {
    const p = (event.payload ?? {}) as Payload;
    const vhicasarId = asString(p.vhicasarId);
    if (!vhicasarId) return;
    // Name the business so the receipt means something in the notification tray.
    let merchant = 'a business';
    if (event.organizationId) {
      const org = await prismaUnscoped.organization.findUnique({
        where: { id: event.organizationId },
        select: { name: true },
      });
      if (org?.name) merchant = org.name;
    }
    await consumerPush.sendToIdentity(vhicasarId, {
      title: 'Payment successful',
      body: `${formatAmount(p.amount, p.currency)} paid to ${merchant}.`,
      data: { type: 'payment', paymentId: asString(p.paymentId) ?? '', sessionId: event.aggregateId },
    });
  });

  eventBus.on('WalletCredited', async (event) => {
    const p = (event.payload ?? {}) as Payload;
    const vhicasarId = asString(p.vhicasarId);
    if (!vhicasarId) return;
    await consumerPush.sendToIdentity(vhicasarId, {
      title: 'Wallet funded',
      body: `${formatAmount(p.amount, p.currency)} added to your wallet.`,
      data: { type: 'wallet', transactionId: asString(p.transactionId) ?? '' },
    });
  });

  eventBus.on('WalletDebited', async (event) => {
    const p = (event.payload ?? {}) as Payload;
    const vhicasarId = asString(p.vhicasarId);
    if (!vhicasarId) return;
    await consumerPush.sendToIdentity(vhicasarId, {
      title: 'Wallet debited',
      body: `${formatAmount(p.amount, p.currency)} left your wallet.`,
      data: { type: 'wallet', transactionId: asString(p.transactionId) ?? '' },
    });
  });

  eventBus.on('TransactionBlocked', async (event) => {
    const p = (event.payload ?? {}) as Payload;
    const vhicasarId = asString(p.vhicasarId);
    if (!vhicasarId) return;
    await consumerPush.sendToIdentity(vhicasarId, {
      title: 'Payment blocked',
      body: 'We stopped a payment that looked unusual. Contact support if this was you.',
      data: { type: 'security', subjectId: event.aggregateId },
    });
  });

  eventBus.on('PayoutPaid', async (event) => {
    const p = (event.payload ?? {}) as Payload;
    const vhicasarId = asString(p.vhicasarId);
    if (!vhicasarId) return;
    await consumerPush.sendToIdentity(vhicasarId, {
      title: 'Withdrawal sent',
      body: `${formatAmount(p.amount, p.currency)} is on its way to your bank.`,
      data: { type: 'payout', payoutId: event.aggregateId },
    });
  });

  eventBus.on('PayoutFailed', async (event) => {
    const p = (event.payload ?? {}) as Payload;
    const vhicasarId = asString(p.vhicasarId);
    if (!vhicasarId) return;
    await consumerPush.sendToIdentity(vhicasarId, {
      title: 'Withdrawal failed',
      body: 'Your withdrawal could not be completed and the money is back in your wallet.',
      data: { type: 'payout', payoutId: event.aggregateId },
    });
  });

  eventBus.on('KycReviewed', async (event) => {
    const p = (event.payload ?? {}) as Payload;
    const vhicasarId = asString(p.vhicasarId);
    if (!vhicasarId) return;
    const approved = p.status === 'APPROVED';
    await consumerPush.sendToIdentity(vhicasarId, {
      title: approved ? 'Identity verified' : 'Verification declined',
      body: approved
        ? 'Your account is verified — higher limits are now available.'
        : 'We could not verify your documents. Please submit them again.',
      data: { type: 'kyc', status: approved ? 'APPROVED' : 'REJECTED' },
    });
  });

  eventBus.on('RewardEarned', async (event) => {
    const p = (event.payload ?? {}) as Payload;
    const vhicasarId = asString(p.vhicasarId);
    if (!vhicasarId) return;
    await consumerPush.sendToIdentity(vhicasarId, {
      title: 'Points earned',
      body: `You earned ${p.points ?? 0} Vhicasar points.`,
      data: { type: 'rewards', points: String(p.points ?? 0) },
    });
  });
}
