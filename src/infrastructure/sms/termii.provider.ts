import { createHmac, timingSafeEqual } from 'crypto';
import type {
  BulkSendResult,
  DeliveryReport,
  SendSmsInput,
  SendSmsResult,
  SenderIdRegistration,
  SmsDeliveryStatus,
  SmsProvider,
  WebhookRequest,
} from '../../application/sms/sms-provider';
import { env } from '../../shared/config/env';
import { AppError } from '../../shared/errors';
import { logger } from '../../shared/logger';

/** Termii's status words, mapped onto Vhicasar's. */
const STATUS_MAP: Record<string, SmsDeliveryStatus> = {
  sent: 'SENT',
  message_sent: 'SENT',
  delivered: 'DELIVERED',
  delivery_ok: 'DELIVERED',
  received: 'DELIVERED',
  failed: 'FAILED',
  delivery_failed: 'FAILED',
  rejected: 'REJECTED',
  dnd_rejected: 'REJECTED',
  expired: 'EXPIRED',
};

/**
 * Termii, the first provider behind the SMS abstraction.
 *
 * Everything Termii-shaped lives here: its request bodies, its status
 * vocabulary, its idea of a channel. Nothing outside this file imports it, so
 * replacing it with Africa's Talking is a new file and a registry line rather
 * than a rewrite of the SMS module.
 */
export class TermiiProvider implements SmsProvider {
  readonly id = 'termii';
  readonly label = 'Termii';

  isConfigured(): boolean {
    return Boolean(env.sms.apiKey);
  }

  private url(path: string): string {
    return `${env.sms.baseUrl.replace(/\/$/, '')}${path}`;
  }

  /**
   * Termii's "dnd" channel reaches numbers on Nigeria's Do-Not-Disturb list.
   * Transactional traffic is permitted there; marketing is not, and routing
   * marketing down it would breach the network's own rules.
   */
  private channelFor(route: SendSmsInput['route']): string {
    return route === 'TRANSACTIONAL' ? 'dnd' : 'generic';
  }

  async sendSms(input: SendSmsInput): Promise<SendSmsResult> {
    const res = await fetch(this.url('/api/sms/send'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: env.sms.apiKey,
        to: input.to,
        from: input.senderId,
        sms: input.body,
        type: 'plain',
        channel: this.channelFor(input.route),
        // Echoed back on the delivery webhook, which is how a receipt finds
        // the message it belongs to.
        reference: input.reference,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      message_id?: string;
      message?: string;
      code?: string;
    };
    if (!res.ok || !json.message_id) {
      throw new AppError(
        'SMS_SEND_FAILED',
        502,
        `SMS send failed: ${json.message ?? json.code ?? res.status}`,
      );
    }
    return { providerMessageId: json.message_id, status: 'SENT' };
  }

  /**
   * Termii's bulk endpoint takes many recipients but one body, so personalised
   * text has to go one at a time. Grouping by body keeps a campaign with no
   * variables to a single call while still allowing per-recipient messages.
   */
  async sendBulkSms(inputs: SendSmsInput[]): Promise<BulkSendResult> {
    const accepted: SendSmsResult[] = [];
    const rejected: { to: string; reason: string }[] = [];

    const groups = new Map<string, SendSmsInput[]>();
    for (const input of inputs) {
      const key = `${input.senderId}|${input.route}|${input.body}`;
      groups.set(key, [...(groups.get(key) ?? []), input]);
    }

    for (const group of groups.values()) {
      // One recipient is not a bulk send; the single endpoint reports per
      // message and gives a better error.
      if (group.length === 1) {
        try {
          accepted.push(await this.sendSms(group[0]!));
        } catch (err) {
          rejected.push({ to: group[0]!.to, reason: (err as Error).message });
        }
        continue;
      }
      const first = group[0]!;
      try {
        const res = await fetch(this.url('/api/sms/send/bulk'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: env.sms.apiKey,
            to: group.map((g) => g.to),
            from: first.senderId,
            sms: first.body,
            type: 'plain',
            channel: this.channelFor(first.route),
          }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          message_id?: string;
          message?: string;
        };
        if (!res.ok || !json.message_id) {
          throw new AppError('SMS_SEND_FAILED', 502, json.message ?? `HTTP ${res.status}`);
        }
        // A bulk send returns one id for the batch, so each recipient carries
        // it suffixed with our own reference to stay individually traceable.
        for (const member of group) {
          accepted.push({
            providerMessageId: `${json.message_id}:${member.reference}`,
            status: 'SENT',
          });
        }
      } catch (err) {
        for (const member of group) {
          rejected.push({ to: member.to, reason: (err as Error).message });
        }
      }
    }
    return { accepted, rejected };
  }

  async getDeliveryStatus(providerMessageId: string): Promise<DeliveryReport | null> {
    const res = await fetch(
      this.url(
        `/api/sms/inbox?api_key=${encodeURIComponent(env.sms.apiKey)}` +
          `&message_id=${encodeURIComponent(providerMessageId)}`,
      ),
    );
    if (!res.ok) return null;
    const json = (await res.json().catch(() => ({}))) as { status?: string };
    const status = STATUS_MAP[String(json.status).toLowerCase()];
    return status ? { providerMessageId, status } : null;
  }

  async registerSenderId(value: string, useCase: string): Promise<SenderIdRegistration> {
    const res = await fetch(this.url('/api/sender-id/request'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: env.sms.apiKey,
        sender_id: value,
        usecase: useCase,
        company: 'Vhicasar',
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok) {
      logger.warn({ status: res.status, message: json.message }, 'Sender ID registration failed');
      return { providerRef: null, status: 'PENDING', automated: false, note: json.message };
    }
    // Termii accepts the request but approves it out of band, so this is
    // PENDING however cleanly it returned — never APPROVED.
    return { providerRef: null, status: 'PENDING', automated: true, note: json.message };
  }

  async getSenderIdStatus(): Promise<SenderIdRegistration | null> {
    // Termii exposes no per-request status endpoint; approval arrives by email
    // to the platform account, which is why the admin queue exists.
    return null;
  }

  verifyWebhook(req: WebhookRequest): boolean {
    const secret = env.sms.webhookSecret;
    // An unsigned webhook is refused rather than trusted: without a secret,
    // anyone who learned the URL could mark messages delivered.
    if (!secret) return false;
    const header = req.headers['x-termii-signature'];
    if (typeof header !== 'string' || !req.rawBody) return false;
    const expected = createHmac('sha512', secret).update(req.rawBody).digest('hex');
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(body: unknown): DeliveryReport[] {
    const payload = body as {
      id?: string;
      message_id?: string;
      reference?: string;
      status?: string;
    };
    const providerMessageId = payload.message_id ?? payload.id;
    const status = STATUS_MAP[String(payload.status).toLowerCase()];
    if (!providerMessageId || !status) return [];
    return [
      {
        providerMessageId,
        reference: payload.reference,
        status,
        rawReason: payload.status,
      },
    ];
  }
}
