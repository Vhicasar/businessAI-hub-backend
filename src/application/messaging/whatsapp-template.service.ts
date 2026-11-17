import { z } from 'zod';
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
 *
 * Templates are also written from here. Meta's Business Management API accepts
 * a template over the same token the inbox already holds, so a business never
 * has to open WhatsApp Manager to compose one. What cannot be skipped is the
 * review: Meta still decides, and takes up to a day over it, so everything
 * here is built around a template that exists but is not yet sendable.
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


/**
 * Meta's name rules: lowercase alphanumeric and underscores, 512 at most.
 *
 * Businesses type "Black Friday Sale". Rejecting that and asking them to
 * rewrite it in snake_case teaches them Meta's constraint for no benefit, so
 * the name they type becomes the name Meta sees, converted here and shown back
 * to them before they submit.
 */
export function slugifyTemplateName(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
    .slice(0, 512);
  return slug;
}

/** Meta names languages `en_US` in a template and `en-US` in a webhook. */
function sameLanguage(a: string, b: string): boolean {
  return a.replace(/-/g, '_').toLowerCase() === b.replace(/-/g, '_').toLowerCase();
}

export const templateDraftSchema = z.object({
  /** What the business typed; slugified before it reaches Meta. */
  name: z.string().trim().min(1).max(512),
  language: z.string().trim().min(2).max(20).default('en_US'),
  category: z.enum(['MARKETING', 'UTILITY']),
  headerText: z.string().trim().max(60).nullable().optional(),
  bodyText: z.string().trim().min(1).max(1024),
  footerText: z.string().trim().max(60).nullable().optional(),
  /** One example per {{n}} in the body, keyed by index as a string. */
  examples: z.record(z.string().trim().min(1).max(1000)).default({}),
});
export type TemplateDraft = z.infer<typeof templateDraftSchema>;

/**
 * Everything that would come back as a rejection, caught before submitting.
 *
 * A rejected template is not free: it is a round trip of up to a day, and a
 * business that collects three of them has a quality problem with Meta rather
 * than a typo. Each of these is a rule Meta states, checked here so the
 * composer can say what is wrong while the author is still looking at it.
 */
export function validateDraft(draft: TemplateDraft): { name: string; errors: string[] } {
  const errors: string[] = [];
  const name = slugifyTemplateName(draft.name);
  if (!name) errors.push('The name must contain at least one letter or number.');

  const indexes = variablesIn(draft.bodyText);
  /*
   * Positional parameters are numbered in order of appearance. A body with
   * {{1}} and {{3}} is not a template with a gap — Meta reads it as malformed
   * and rejects it, so the gap is caught here instead.
   */
  const sequential = indexes.every((value, position) => value === position + 1);
  if (!sequential) {
    errors.push(`Placeholders must run 1, 2, 3… without gaps. Found ${indexes.map((i) => `{{${i}}}`).join(', ')}.`);
  }
  for (const index of indexes) {
    if (!(draft.examples[String(index)] ?? '').trim()) {
      errors.push(`{{${index}}} has no example. Meta will not approve a template whose placeholders are unexplained.`);
    }
  }
  if (variablesIn(draft.headerText ?? '').length) {
    errors.push('The header cannot contain a placeholder here. Put variable text in the body.');
  }
  if (variablesIn(draft.footerText ?? '').length) {
    errors.push('The footer cannot contain a placeholder.');
  }
  return { name, errors };
}

/** The template as Meta's API wants it. */
function componentsFor(draft: TemplateDraft): RawComponent[] {
  const components: RawComponent[] = [];
  if (draft.headerText?.trim()) {
    components.push({ type: 'HEADER', format: 'TEXT', text: draft.headerText.trim() });
  }
  const indexes = variablesIn(draft.bodyText);
  components.push({
    type: 'BODY',
    text: draft.bodyText,
    ...(indexes.length
      ? { example: { body_text: [indexes.map((index) => draft.examples[String(index)] ?? '')] } }
      : {}),
  });
  if (draft.footerText?.trim()) {
    components.push({ type: 'FOOTER', text: draft.footerText.trim() });
  }
  return components;
}

/** The access the Business Management API needs, or a reason it is missing. */
async function metaCredentials(accountId: string, organizationId: string) {
  const account = await loadAccount(accountId, organizationId);
  const metadata = (account.metadata ?? {}) as Record<string, unknown>;
  const wabaId = typeof metadata.wabaId === 'string' ? metadata.wabaId : null;
  if (!wabaId || !account.credentialsEnc) {
    throw new AppError('CHANNEL_MISCONFIGURED', 400, 'This WhatsApp channel has no Business Account to manage templates on.');
  }
  const credentials = JSON.parse(decrypt(account.credentialsEnc)) as { accessToken?: string };
  if (!credentials.accessToken) {
    throw new AppError('CHANNEL_MISCONFIGURED', 400, 'This WhatsApp channel has no usable access token.');
  }
  return { account, metadata, wabaId, accessToken: credentials.accessToken };
}

/**
 * Meta's refusals, in words the person who wrote the template can act on.
 *
 * Error 80008 is the one that matters most: it is not a fault in the template
 * at all, it is the per-account creation rate, and telling someone their
 * template is wrong when it is merely too soon sends them rewriting good copy.
 */
function createFailure(code: number | undefined, message: string | undefined): AppError {
  if (code === 80008) {
    return new AppError('TEMPLATE_RATE_LIMITED', 429,
      'Meta is limiting how many templates this WhatsApp account can create right now. Wait a few minutes and submit again — nothing is wrong with the template.');
  }
  if (code === 100 && /name/i.test(message ?? '')) {
    return new AppError('TEMPLATE_NAME_REJECTED', 400,
      `Meta would not accept that name: ${message}. A template with this name may already exist in this language.`);
  }
  return new AppError('TEMPLATE_CREATE_FAILED', 502, `Meta would not accept the template: ${message ?? 'no reason given'}`);
}


/** One decision Meta made about one template. */
export interface TemplateStatusUpdate {
  name: string;
  language: string | null;
  /** APPROVED, REJECTED, PAUSED, DISABLED, FLAGGED, REINSTATED… */
  event: string;
  reason: string | null;
}

/**
 * The template decisions inside a Meta webhook delivery, if any.
 *
 * These arrive on the same callback as inbound messages, told apart only by
 * the change's `field`. Everything else in the delivery is left alone, so a
 * payload carrying both a message and a template decision still does both.
 */
export function parseTemplateStatusUpdates(body: unknown): TemplateStatusUpdate[] {
  const payload = body as {
    entry?: Array<{ changes?: Array<{ field?: string; value?: Record<string, unknown> }> }>;
  };
  const out: TemplateStatusUpdate[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'message_template_status_update') continue;
      const value = change.value ?? {};
      const name = typeof value.message_template_name === 'string' ? value.message_template_name : '';
      if (!name) continue;
      const rejection = value.rejection_info as { reason?: string } | undefined;
      const reason = rejection?.reason
        ?? (typeof value.reason === 'string' && value.reason !== 'NONE' ? value.reason : null);
      out.push({
        name,
        language: typeof value.message_template_language === 'string' ? value.message_template_language : null,
        event: String(value.event ?? 'UNKNOWN').toUpperCase(),
        reason: reason ?? null,
      });
    }
  }
  return out;
}


/**
 * Meta's read refusals, in terms of what to do about them.
 *
 * Code 3 and code 200 both mean the Meta app itself is missing something —
 * usually Advanced Access to `whatsapp_business_management` — rather than
 * anything being wrong with this WhatsApp account. Repeating Meta's wording
 * alone ("Application does not have the capability…") sends people looking in
 * the wrong place.
 */
function templateReadFailure(code: number | undefined, message: string | undefined, status: number): string {
  if (code === 3 || code === 200) {
    return 'Meta refused the request because the connected Meta app is missing the '
      + 'whatsapp_business_management permission. Templates already synced are still shown; '
      + 'granting that permission to the app restores refreshing and in-app template creation. '
      + `Meta said: ${message ?? `HTTP ${status}`}`;
  }
  if (code === 190) {
    return 'Meta rejected the stored access token. Reconnect this WhatsApp channel in '
      + `Settings → Channels to issue a new one. Meta said: ${message ?? `HTTP ${status}`}`;
  }
  return `Meta would not return templates: ${message ?? status}`;
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
    const base = `${env.meta.graphUrl}/${wabaId}/message_templates?fields=${encodeURIComponent(fields)}&limit=200`;
    const headers = { Authorization: `Bearer ${credentials.accessToken}` };

    type TemplatePage = {
      data?: RawTemplate[];
      summary?: { message_template_count?: number; message_template_limit?: number; total_count?: number };
      error?: { message?: string; code?: number };
    };
    const read = async (url: string): Promise<{ res: Response; json: TemplatePage }> => {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      return { res, json: (await res.json().catch(() => ({}))) as TemplatePage };
    };

    /*
     * `summary=true` reports how many templates the account holds and may hold,
     * which is what the composer shows as headroom. Reading the cap is its own
     * capability, though, and an app that lacks it fails the WHOLE request with
     * "(#3) Application does not have the capability to make this API call" —
     * so asking for the headroom cost the business its template list entirely,
     * while the connect-time sync (which never asked) kept working.
     *
     * The quota is a nicety. The list is not. So it is asked for once and
     * dropped the moment it gets in the way.
     */
    let { res, json } = await read(`${base}&summary=true`);
    if (!res.ok) {
      logger.info(
        { accountId, status: res.status, metaCode: json.error?.code },
        'WhatsApp template refresh with summary refused; retrying without it',
      );
      ({ res, json } = await read(base));
    }
    if (!res.ok) {
      logger.warn({ accountId, status: res.status, metaCode: json.error?.code }, 'WhatsApp template refresh failed');
      throw new AppError('TEMPLATE_SYNC_FAILED', 502, templateReadFailure(json.error?.code, json.error?.message, res.status));
    }
    const items = json.data ?? [];
    const count = json.summary?.message_template_count ?? json.summary?.total_count ?? null;
    const limit = json.summary?.message_template_limit ?? null;
    await prismaUnscoped.channelAccount.update({
      where: { id: accountId },
      data: {
        metadata: {
          ...metadata, messageTemplates: items,
          templateSyncStatus: 'READY', templateSyncedAt: new Date().toISOString(),
          /* Absent when Meta omits the summary; never overwritten with null. */
          ...(count === null && limit === null ? {} : { templateQuota: { count, limit } }),
        } as object,
      },
    });
    logger.info({ accountId, count: items.length }, 'WhatsApp templates refreshed');
    return items.map(shape).filter((item) => item.name);
  },


  /**
   * Submit a new template to Meta for review.
   *
   * The template comes back PENDING and is stored immediately, so it appears
   * in the campaign builder — greyed out, with its status on it — rather than
   * vanishing until someone remembers to refresh. Meta decides later, and
   * `applyStatusUpdate` records what it decided.
   */
  async create(accountId: string, organizationId: string, draft: TemplateDraft): Promise<WhatsAppTemplate> {
    const { name, errors } = validateDraft(draft);
    if (errors.length) throw new ValidationError(errors.join(' '));

    const { metadata, wabaId, accessToken } = await metaCredentials(accountId, organizationId);
    const payload = {
      name,
      language: draft.language,
      category: draft.category,
      /*
       * Meta re-files a template it judges miscategorised instead of refusing
       * it outright. Without this, a marketing message written as a utility
       * one comes back REJECTED a day later for a reason the author cannot
       * see; with it, Meta simply corrects the category and approves.
       */
      allow_category_change: true,
      components: componentsFor(draft),
    };
    const res = await fetch(`${env.meta.graphUrl}/${wabaId}/message_templates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      id?: string; status?: string; category?: string; error?: { code?: number; message?: string };
    };
    if (!res.ok || !json.id) {
      logger.warn({ accountId, status: res.status, metaCode: json.error?.code }, 'WhatsApp template creation refused');
      throw createFailure(json.error?.code, json.error?.message);
    }

    const stored: RawTemplate = {
      name,
      language: draft.language,
      category: json.category ?? draft.category,
      status: json.status ?? 'PENDING',
      components: componentsFor(draft),
    };
    const existing = Array.isArray(metadata.messageTemplates) ? metadata.messageTemplates as RawTemplate[] : [];
    const items = [
      ...existing.filter((item) => !(item.name === name && sameLanguage(item.language ?? '', draft.language))),
      stored,
    ];
    await prismaUnscoped.channelAccount.update({
      where: { id: accountId },
      data: { metadata: { ...metadata, messageTemplates: items } as object },
    });
    logger.info({ accountId, name, category: stored.category, status: stored.status }, 'WhatsApp template submitted for review');
    return shape(stored);
  },

  /**
   * Withdraw a template from the WhatsApp Business Account.
   *
   * Meta deletes every language variant sharing the name, which is why the
   * name alone identifies it. A template still being reviewed can be removed
   * the same way, so a mistake does not have to wait out its own approval.
   */
  async remove(accountId: string, organizationId: string, name: string): Promise<void> {
    const { metadata, wabaId, accessToken } = await metaCredentials(accountId, organizationId);
    const res = await fetch(
      `${env.meta.graphUrl}/${wabaId}/message_templates?name=${encodeURIComponent(name)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) },
    );
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: { message?: string } };
    if (!res.ok) {
      throw new AppError('TEMPLATE_DELETE_FAILED', 502, `Meta would not delete the template: ${json.error?.message ?? res.status}`);
    }
    const existing = Array.isArray(metadata.messageTemplates) ? metadata.messageTemplates as RawTemplate[] : [];
    await prismaUnscoped.channelAccount.update({
      where: { id: accountId },
      data: { metadata: { ...metadata, messageTemplates: existing.filter((item) => item.name !== name) } as object },
    });
    logger.info({ accountId, name }, 'WhatsApp template deleted');
  },

  /**
   * Record what Meta decided, from the `message_template_status_update` hook.
   *
   * Approval arrives on Meta's schedule — minutes, or the better part of a
   * day. Without this the only way to learn the outcome is for somebody to
   * reopen the campaign builder and press refresh, so a template approved
   * overnight sits unusable until it is noticed.
   *
   * Returns false when the update names a template this account does not hold,
   * which is normal: one WABA can be shared, and not every change is ours.
   */
  async applyStatusUpdate(
    accountId: string,
    update: { name: string; language: string | null; event: string; reason: string | null },
  ): Promise<boolean> {
    const account = await prismaUnscoped.channelAccount.findFirst({
      where: { id: accountId, channelType: 'WHATSAPP', deletedAt: null },
      select: { id: true, metadata: true },
    });
    if (!account) return false;
    const metadata = (account.metadata ?? {}) as Record<string, unknown>;
    const items = Array.isArray(metadata.messageTemplates) ? metadata.messageTemplates as RawTemplate[] : [];
    let touched = false;
    const next = items.map((item) => {
      const matches = item.name === update.name
        && (!update.language || sameLanguage(item.language ?? '', update.language));
      if (!matches) return item;
      touched = true;
      return {
        ...item,
        status: update.event,
        /* REJECTED carries the reason; anything else clears a stale one. */
        rejected_reason: update.event === 'REJECTED' ? update.reason ?? undefined : undefined,
      };
    });
    if (!touched) return false;
    await prismaUnscoped.channelAccount.update({
      where: { id: account.id },
      data: { metadata: { ...metadata, messageTemplates: next } as object },
    });
    logger.info({ accountId, name: update.name, event: update.event }, 'WhatsApp template status updated by Meta');
    return true;
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
