import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import type {
  BulkSendResult,
  DeliveryReport,
  SendSmsInput,
  SendSmsResult,
  SenderIdRegistration,
  SmsProvider,
  WebhookRequest,
} from '../../application/sms/sms-provider';
import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';

/**
 * An SMS provider that sends nothing.
 *
 * Vhicasar's provider account, its Sender ID approvals and its credit float
 * are all somebody else's process. This lets the composer, the wallet, the
 * campaign runner and the delivery-receipt path be built and demonstrated
 * before any of that lands.
 *
 * It is the default provider, deliberately: a deployment with no SMS_API_KEY
 * gets a module that works end to end and charges nothing real, rather than
 * one that throws at the first send. What it never does is claim a message
 * reached a phone — every send is logged loudly as simulated.
 */
export class MockSmsProvider implements SmsProvider {
  readonly id = 'mock';
  readonly label = 'Simulated (development)';

  /** Sends recorded in memory, so a test or demo can assert on them. */
  readonly outbox: (SendSmsInput & { providerMessageId: string })[] = [];

  isConfigured(): boolean {
    return true;
  }

  async sendSms(input: SendSmsInput): Promise<SendSmsResult> {
    const providerMessageId = `mock-sms-${randomUUID()}`;
    this.outbox.push({ ...input, providerMessageId });
    logger.info(
      { to: input.to, senderId: input.senderId, route: input.route, providerMessageId },
      'SIMULATED SMS — no message was actually sent',
    );
    return { providerMessageId, status: 'SENT' };
  }

  async sendBulkSms(inputs: SendSmsInput[]): Promise<BulkSendResult> {
    const accepted: SendSmsResult[] = [];
    const rejected: { to: string; reason: string }[] = [];
    for (const input of inputs) {
      // A number the normaliser would have caught is rejected here too, so a
      // demo can exercise the partial-failure path on purpose.
      if (input.to.includes('0000000000')) {
        rejected.push({ to: input.to, reason: 'Simulated rejection: unreachable number' });
        continue;
      }
      accepted.push(await this.sendSms(input));
    }
    return { accepted, rejected };
  }

  async getDeliveryStatus(providerMessageId: string): Promise<DeliveryReport | null> {
    return { providerMessageId, status: 'DELIVERED' };
  }

  async registerSenderId(): Promise<SenderIdRegistration> {
    return {
      providerRef: `mock-sender-${randomUUID()}`,
      status: 'PENDING',
      automated: true,
      note: 'Simulated registration. Approve it from the Vhicasar admin queue.',
    };
  }

  async getSenderIdStatus(providerRef: string): Promise<SenderIdRegistration | null> {
    return { providerRef, status: 'PENDING', automated: true };
  }

  /**
   * Verifies a signature when one is configured, and only then.
   *
   * It used to accept anything on the reasoning that this provider never runs
   * in production. True, but it meant a deployment that had set
   * SMS_WEBHOOK_SECRET — staging, a demo, a developer testing the real
   * flow — silently had no verification at all, and a forged receipt could
   * mark messages delivered. Now the secret is honoured wherever it is set,
   * and the permissive path is reserved for a deployment that has genuinely
   * configured nothing.
   */
  verifyWebhook(req: WebhookRequest): boolean {
    const secret = env.sms.webhookSecret;
    if (!secret) return true;
    const header = req.headers['x-vhicasar-signature'];
    if (typeof header !== 'string' || !req.rawBody) return false;
    const expected = createHmac('sha256', secret).update(req.rawBody).digest('hex');
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(body: unknown): DeliveryReport[] {
    const payload = body as { reports?: DeliveryReport[] };
    return payload.reports ?? [];
  }
}
