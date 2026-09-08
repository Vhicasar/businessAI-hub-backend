import type { SegmentInfo } from './sms-segments';

/**
 * The SMS provider, behind one interface.
 *
 * Vhicasar holds the provider account centrally — businesses never see an API
 * key, a dashboard, or which provider it is. That makes the choice of provider
 * Vhicasar's to change, which is only true if nothing outside this folder
 * knows the difference between Termii and Africa's Talking.
 *
 * So: no provider names in the composer, the campaign runner, the wallet or
 * the webhook handler. They speak to this, and a new provider is a new file
 * plus a registry line.
 */

export type SmsDeliveryStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'FAILED' | 'REJECTED' | 'EXPIRED';

/** Transactional traffic often takes a different, higher-priority route. */
export type SmsRoute = 'TRANSACTIONAL' | 'PROMOTIONAL';

export interface SendSmsInput {
  /** E.164, already normalised and deduplicated. */
  to: string;
  body: string;
  /** The approved Sender ID's value, not its row id. */
  senderId: string;
  route: SmsRoute;
  /** Ours, echoed back on webhooks so a receipt can find its message. */
  reference: string;
}

export interface SendSmsResult {
  /** The provider's id, for matching delivery receipts. */
  providerMessageId: string;
  status: SmsDeliveryStatus;
  /** What the provider says it will charge, when it says so at send time. */
  providerCost?: number;
  segments?: number;
}

export interface BulkSendResult {
  accepted: SendSmsResult[];
  /** Rejected outright — a bad number, a blocked route. */
  rejected: { to: string; reason: string }[];
}

export interface DeliveryReport {
  providerMessageId: string;
  /** Ours, when the provider echoes it. */
  reference?: string;
  status: SmsDeliveryStatus;
  occurredAt?: Date;
  /** The provider's own words — for the log, never for the business. */
  rawReason?: string;
  providerCost?: number;
}

export interface SenderIdRegistration {
  /** The provider's id for the request, when it registers programmatically. */
  providerRef: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  /**
   * False when the provider has no registration API and a human at Vhicasar
   * must submit it. Surfaced so the admin queue can say which requests still
   * need doing by hand rather than pretending they are in flight.
   */
  automated: boolean;
  note?: string;
}

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: Buffer;
}

export interface SmsProvider {
  readonly id: string;
  readonly label: string;

  /** Whether credentials are present. False means nothing can be sent. */
  isConfigured(): boolean;

  sendSms(input: SendSmsInput): Promise<SendSmsResult>;

  /**
   * Send many at once.
   *
   * Separate from sendSms because providers bill and rate-limit bulk sends
   * differently, and a campaign that fired a thousand single requests would be
   * throttled long before it finished.
   */
  sendBulkSms(inputs: SendSmsInput[]): Promise<BulkSendResult>;

  /** Poll, for providers whose webhooks are unreliable or absent. */
  getDeliveryStatus(providerMessageId: string): Promise<DeliveryReport | null>;

  registerSenderId(value: string, useCase: string): Promise<SenderIdRegistration>;
  getSenderIdStatus(providerRef: string): Promise<SenderIdRegistration | null>;

  /** Reject anything not genuinely from the provider. */
  verifyWebhook(req: WebhookRequest): boolean;
  /** Zero or more receipts from one delivery. */
  parseWebhook(body: unknown): DeliveryReport[];

  /**
   * What the provider will charge, when it can be known before sending.
   *
   * Distinct from what Vhicasar charges the business: the margin is admin
   * configuration, and mixing the two would make the ledger unauditable.
   */
  estimateCost?(segments: SegmentInfo, route: SmsRoute): number | null;
}
