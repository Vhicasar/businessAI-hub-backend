import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { decrypt } from '../../shared/crypto';
import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';
import { AppError, NotFoundError, ValidationError } from '../../shared/errors';

/**
 * The approved message templates a business may send a campaign with.
 *
 * Meta requires an approved template for a business-initiated message outside
 * the customer-service window, so the template is not a nicety — it is the
 * only legal shape a marketing message can take. Picking one by typing its
 * name, which is what this product did before, meant a typo or a template Meta
 * had since paused failed at dispatch, one recipient at a time.
 *
 * Templates are synced into the channel's metadata when it connects; this
 * refreshes them on demand, because approval status changes without warning
 * and a campaign built on yesterday's list is built on a guess.
 */

export interface TemplateVariable {
  /** 1-based index as Meta numbers them: {{1}}, {{2}}… */
  index: number;
  /** The sample Meta holds, shown to explain what belongs here. */
  example: string | null;
}

export interface WhatsAppTemplate {
  name: string;
  language: string;
  category: string;
  status: string;
  /** Usable for a campaign right now. */
  eligible: boolean;
  /** Why not, when it is not. */
  ineligibleReason: string | null;
  bodyText: string;
  headerText: string | null;
  footerText: string | null;
  variables: TemplateVariable[];
  rejectedReason: string | null;
  qualityScore: string | null;
}

interface RawComponent {
  type?: string;
  format?: string;
  text?: string;
  example?: { body_text?: string[][]; header_text?: string[] };
}

interface RawTemplate {
  name?: string;
  language?: string;
  category?: string;
  status?: string;
  rejected_reason?: string;
  quality_score?: { score?: string };
  components?: RawComponent[];
}

/** Meta numbers template placeholders {{1}}, {{2}}… in order of appearance. */
export function variablesIn(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    const index = Number(match[1]);
    if (Number.isInteger(index) && index > 0) found.add(index);
  }
  return [...found].sort((a, b) => a - b);
}

function shape(raw: RawTemplate): WhatsAppTemplate {
  const components = raw.components ?? [];
  const body = components.find((c) => c.type?.toUpperCase() === 'BODY');
  const header = components.find((c) => c.type?.toUpperCase() === 'HEADER');
  const footer = components.find((c) => c.type?.toUpperCase() === 'FOOTER');
  const bodyText = body?.text ?? '';
  const samples = body?.example?.body_text?.[0] ?? [];
  const status = String(raw.status ?? 'UNKNOWN').toUpperCase();

  /*
   * Only APPROVED may be sent. PAUSED and DISABLED are Meta's response to
   * poor quality and will reject at dispatch; offering them would turn a
   * whole campaign into a wall of failures.
   */
  const eligible = status === 'APPROVED';
  const ineligibleReason = eligible ? null
    : status === 'PENDING' ? 'Waiting for Meta approval'
    : status === 'REJECTED' ? `Rejected by Meta${raw.rejected_reason ? `: ${raw.rejected_reason}` : ''}`
    : status === 'PAUSED' ? 'Paused by Meta for quality reasons'
    : status === 'DISABLED' ? 'Disabled by Meta'
    : `Not available (${status})`;

  return {
    name: String(raw.name ?? ''),
    language: String(raw.language ?? 'en_US'),
    category: String(raw.category ?? 'UNKNOWN').toUpperCase(),
    status,
    eligible,
    ineligibleReason,
    bodyText,
    headerText: header?.format?.toUpperCase() === 'TEXT' ? header.text ?? null : null,
    footerText: footer?.text ?? null,
    variables: variablesIn(bodyText).map((index) => ({
      index,
      example: samples[index - 1] ?? null,
    })),
    rejectedReason: raw.rejected_reason ?? null,
    qualityScore: raw.quality_score?.score ?? null,
  };
}

async function loadAccount(accountId: string, organizationId: string) {
  const account = await prismaUnscoped.channelAccount.findFirst({
    where: { id: accountId, organizationId, channelType: 'WHATSAPP', deletedAt: null },
    select: { id: true, metadata: true, credentialsEnc: true },
  });
  if (!account) throw new NotFoundError('WhatsApp channel');
  return account;
}

export const whatsappTemplateService = {
  /** Templates as last synced, without contacting Meta. */
  async list(accountId: string, organizationId: string): Promise<WhatsAppTemplate[]> {
    const account = await loadAccount(accountId, organizationId);
    const metadata = (account.metadata ?? {}) as { messageTemplates?: unknown };
    const items = Array.isArray(metadata.messageTemplates) ? metadata.messageTemplates : [];
    return items.map((item) => shape(item as RawTemplate)).filter((item) => item.name);
  },

  /**
   * Re-read the templates from Meta and store them.
   *
   * Approval status changes on Meta's schedule, not ours, so the campaign
   * builder refreshes rather than trusting what was true at connect time.
   */
  async refresh(accountId: string, organizationId: string): Promise<WhatsAppTemplate[]> {
    const account = await loadAccount(accountId, organizationId);
    const metadata = (account.metadata ?? {}) as Record<string, unknown>;
    const wabaId = typeof metadata.wabaId === 'string' ? metadata.wabaId : null;
    if (!wabaId || !account.credentialsEnc) {
      throw new AppError('CHANNEL_MISCONFIGURED', 400, 'This WhatsApp channel has no Business Account to read templates from.');
    }
    const credentials = JSON.parse(decrypt(account.credentialsEnc)) as { accessToken?: string };
    if (!credentials.accessToken) {
      throw new AppError('CHANNEL_MISCONFIGURED', 400, 'This WhatsApp channel has no usable access token.');
    }
    const fields = 'id,language,name,rejected_reason,status,category,sub_category,last_updated_time,components,quality_score';
    const res = await fetch(
      `${env.meta.graphUrl}/${wabaId}/message_templates?fields=${encodeURIComponent(fields)}&limit=200`,
      { headers: { Authorization: `Bearer ${credentials.accessToken}` }, signal: AbortSignal.timeout(15_000) },
    );
    const json = (await res.json().catch(() => ({}))) as { data?: RawTemplate[]; error?: { message?: string } };
    if (!res.ok) {
      logger.warn({ accountId, status: res.status }, 'WhatsApp template refresh failed');
      throw new AppError('TEMPLATE_SYNC_FAILED', 502, `Meta would not return templates: ${json.error?.message ?? res.status}`);
    }
    const items = json.data ?? [];
    await prismaUnscoped.channelAccount.update({
      where: { id: accountId },
      data: { metadata: { ...metadata, messageTemplates: items, templateSyncStatus: 'READY', templateSyncedAt: new Date().toISOString() } as object },
    });
    logger.info({ accountId, count: items.length }, 'WhatsApp templates refreshed');
    return items.map(shape).filter((item) => item.name);
  },

  /** The one template a campaign names, or a clear refusal. */
  async requireEligible(accountId: string, organizationId: string, name: string, language: string): Promise<WhatsAppTemplate> {
    const templates = await this.list(accountId, organizationId);
    const template = templates.find((item) => item.name === name && item.language === language)
      ?? templates.find((item) => item.name === name);
    if (!template) {
      throw new ValidationError(`Template "${name}" is not available on this WhatsApp account. Refresh templates and choose again.`);
    }
    if (!template.eligible) {
      throw new AppError('TEMPLATE_NOT_SENDABLE', 400, `"${name}" cannot be used: ${template.ineligibleReason}`);
    }
    return template;
  },

  /**
   * Fill a template's placeholders, refusing rather than guessing.
   *
   * A missing variable is not padded with an empty string: Meta rejects the
   * send, and a half-written message is worse than no message.
   */
  render(template: WhatsAppTemplate, values: Record<string, string>): { text: string; parameters: string[] } {
    const parameters: string[] = [];
    for (const variable of template.variables) {
      const value = values[String(variable.index)];
      if (value === undefined || value === '') {
        throw new ValidationError(`Template variable {{${variable.index}}} has no value.`);
      }
      parameters.push(value);
    }
    const text = template.bodyText.replace(/\{\{\s*(\d+)\s*\}\}/g, (_match, index: string) => values[index] ?? `{{${index}}}`);
    return { text, parameters };
  },
};
