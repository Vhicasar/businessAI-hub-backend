import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { logger } from '../../shared/logger';
import { ValidationError } from '../../shared/errors';
import { activityService } from './activity.service';
import { validateLeadCondition } from './lead-fields.service';
import { announceAssignment } from './assignment-notify.service';
import { messagingService } from '../messaging/messaging.service';
import { enqueue } from '../../infrastructure/queue/queue';

/**
 * Workflow automation engine. Rules live in `organization.settings.workflows`
 * (migration-free) and are dispatched synchronously at business moments
 * (lead created, deal won, order paid, …). Execution is best-effort: a failing
 * rule never breaks the operation that triggered it. Every run is logged to the
 * unified timeline, so automations are auditable.
 */

export const TRIGGERS = [
  'lead.created',
  'lead.qualified',
  'lead.status_changed',
  'deal.created',
  'deal.stage_changed',
  'deal.won',
  'deal.lost',
  'order.placed',
  'order.paid',
  'order.refunded',
  'invoice.paid',
  'payroll.paid',
  'appointment.booked',
] as const;
export type Trigger = (typeof TRIGGERS)[number];

type EntityType = 'CUSTOMER' | 'LEAD' | 'DEAL' | 'ORDER' | 'INVOICE' | 'EMPLOYEE';

const conditionSchema = z.object({
  // Validated against the Lead field catalog on save; the enum here only keeps
  // the shape sane. `customFields.x` is a legal path.
  field: z.string().trim().min(1).max(120),
  op: z.enum([
    'eq', 'ne', 'gt', 'gte', 'lt', 'lte',
    'contains', 'not_contains', 'starts_with', 'is_true', 'is_false',
  ]),
  // Boolean operators carry no operand, so this may be blank.
  value: z.string().max(200).default(''),
});
const actionSchema = z.object({
  type: z.enum([
    'create_task', 'add_note', 'notify', 'send_email', 'send_whatsapp', 'send_sms',
    // Handing work to someone is an action in its own right — previously the
    // only way to route a lead was to change the owner by hand.
    'assign_lead', 'assign_deal',
  ]),
  params: z.record(z.string(), z.string()).default({}),
});
export const workflowSchema = z.object({
  id: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  trigger: z.enum(TRIGGERS),
  conditions: z.array(conditionSchema).max(20).default([]),
  actions: z.array(actionSchema).min(1).max(10),
});
export const saveWorkflowsSchema = z.object({ workflows: z.array(workflowSchema).max(100) });

export type WorkflowRule = z.infer<typeof workflowSchema>;
export type Payload = Record<string, unknown>;
export interface Target {
  entityType: EntityType;
  entityId: string;
  customerId?: string | null;
  ownerId?: string | null;
}

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}

async function readWorkflows(): Promise<WorkflowRule[]> {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: orgId() },
    select: { settings: true },
  });
  const list = ((org.settings as Record<string, unknown>) ?? {}).workflows;
  return Array.isArray(list) ? (list as WorkflowRule[]) : [];
}

/** Follow a dotted path so `customFields.industry` reads the nested value. */
function readField(payload: Payload, path: string): unknown {
  if (!path.includes('.')) return payload[path];
  return path.split('.').reduce<unknown>((value, key) => {
    if (value === null || value === undefined || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[key];
  }, payload);
}

/** ISO-ish strings compare as dates; anything else is not a date comparison. */
function asDate(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function evalCondition(payload: Payload, c: z.infer<typeof conditionSchema>): boolean {
  const raw = readField(payload, c.field);

  // Booleans are about presence and truthiness, so they are judged before the
  // null guard — "is false" must match a field that is absent or false.
  if (c.op === 'is_true') return raw === true || String(raw).toLowerCase() === 'true';
  if (c.op === 'is_false') return raw === false || String(raw).toLowerCase() === 'false' || raw === undefined || raw === null;

  if (raw === undefined || raw === null) return false;

  const left = String(raw).toLowerCase();
  const right = c.value.toLowerCase();

  // Dates first: "2026-01-02" > "2026-01-10" is true as a string and wrong.
  const leftDate = asDate(raw);
  const rightDate = asDate(c.value);
  if (leftDate !== null && rightDate !== null) {
    switch (c.op) {
      case 'eq': return leftDate === rightDate;
      case 'ne': return leftDate !== rightDate;
      case 'gt': return leftDate > rightDate;
      case 'gte': return leftDate >= rightDate;
      case 'lt': return leftDate < rightDate;
      case 'lte': return leftDate <= rightDate;
      default: break;
    }
  }

  const asNum = Number(raw);
  const cmpNum = Number(c.value);
  const numeric = c.value !== '' && !Number.isNaN(asNum) && !Number.isNaN(cmpNum);

  switch (c.op) {
    case 'eq':
      return numeric ? asNum === cmpNum : left === right;
    case 'ne':
      return numeric ? asNum !== cmpNum : left !== right;
    case 'contains':
      return left.includes(right);
    case 'not_contains':
      return !left.includes(right);
    case 'starts_with':
      return left.startsWith(right);
    case 'gt':
      return numeric && asNum > cmpNum;
    case 'gte':
      return numeric && asNum >= cmpNum;
    case 'lt':
      return numeric && asNum < cmpNum;
    case 'lte':
      return numeric && asNum <= cmpNum;
    default:
      return false;
  }
}

async function runAction(
  action: z.infer<typeof actionSchema>,
  payload: Payload,
  target: Target,
): Promise<void> {
  const org = orgId();
  const p = action.params;
  if (action.type === 'create_task') {
    await prisma.task.create({
      data: {
        organizationId: org,
        title: interpolate(p.title || 'Follow up', payload),
        description: p.description ? interpolate(p.description, payload) : null,
        priority: (p.priority && ['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(p.priority)
          ? p.priority
          : 'MEDIUM') as 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT',
        assigneeId: target.ownerId ?? null,
        entityType: target.entityType,
        entityId: target.entityId,
        dueAt: p.dueInDays ? new Date(Date.now() + Number(p.dueInDays) * 86_400_000) : null,
      },
    });
  } else if (action.type === 'add_note') {
    await prisma.note.create({
      data: {
        organizationId: org,
        entityType: target.entityType,
        entityId: target.entityId,
        body: interpolate(p.body || '', payload),
      },
    });
    await activityService.record({
      type: 'NOTE',
      entityType: target.entityType,
      entityId: target.entityId,
      title: 'Automation added a note',
      body: interpolate(p.body || '', payload),
    });
  } else if (action.type === 'notify') {
    await activityService.record({
      type: 'SYSTEM',
      entityType: target.entityType,
      entityId: target.entityId,
      title: interpolate(p.message || 'Automation notification', payload),
      also: target.customerId ? [{ entityType: 'CUSTOMER', entityId: target.customerId }] : undefined,
    });
  } else if (action.type === 'assign_lead' || action.type === 'assign_deal') {
    const wanted = action.type === 'assign_lead' ? 'lead' : 'deal';
    if (target.entityType !== (wanted === 'lead' ? 'LEAD' : 'DEAL')) {
      // A lead rule cannot assign a deal. Say so rather than doing nothing.
      throw new Error(`This rule runs on a ${target.entityType.toLowerCase()}, so it cannot ${action.type.replace('_', ' ')}`);
    }
    const ownerId = (p.ownerId ?? '').trim();
    if (!ownerId) throw new Error('No user selected to assign to');

    const member = await prisma.membership.findFirst({
      where: { id: ownerId, isActive: true, deletedAt: null },
      select: { id: true },
    });
    if (!member) throw new Error('The selected user is no longer an active member');

    // Written here rather than through crmService.assign, which would make the
    // import circular. `announceAssignment` is the shared part that matters:
    // the new owner is notified and the hand-off reaches the timeline exactly
    // as it would from a manual assignment.
    const previousOwnerId =
      wanted === 'lead'
        ? (await prisma.lead.findFirst({ where: { id: target.entityId }, select: { ownerId: true } }))?.ownerId ?? null
        : (await prisma.deal.findFirst({ where: { id: target.entityId }, select: { ownerId: true } }))?.ownerId ?? null;

    if (previousOwnerId === ownerId) return; // already theirs; not a hand-off

    if (wanted === 'lead') {
      await prisma.lead.update({ where: { id: target.entityId }, data: { ownerId } });
    } else {
      await prisma.deal.update({ where: { id: target.entityId }, data: { ownerId } });
    }
    await announceAssignment({
      entity: wanted,
      entityId: target.entityId,
      previousOwnerId,
      newOwnerId: ownerId,
      source: 'AUTOMATION',
    });
  } else if (action.type === 'send_email' || action.type === 'send_whatsapp' || action.type === 'send_sms') {
    // Deliver to the customer tied to this event (leads without a customer are skipped).
    const customerId = target.customerId ?? (target.entityType === 'CUSTOMER' ? target.entityId : null);
    if (!customerId) return;
    const channel = action.type === 'send_email' ? 'EMAIL' : action.type === 'send_whatsapp' ? 'WHATSAPP' : 'SMS';
    const outcome = await messagingService.sendToCustomer(customerId, channel, interpolate(p.message || '', payload));
    await activityService.record({
      type: channel === 'EMAIL' ? 'EMAIL' : channel === 'SMS' ? 'SMS' : 'WHATSAPP',
      entityType: 'CUSTOMER',
      entityId: customerId,
      title: outcome.ok ? `Automation sent a ${channel.toLowerCase()} message` : `Automation ${channel.toLowerCase()} send failed`,
      body: outcome.ok ? undefined : outcome.error,
    });
  }
}

/** Replace {{field}} tokens in text with payload values. */
function interpolate(text: string, payload: Payload): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) =>
    payload[k] !== undefined && payload[k] !== null ? String(payload[k]) : '',
  );
}

export const workflowService = {
  async getWorkflows() {
    return readWorkflows();
  },

  async saveWorkflows(workflows: WorkflowRule[]) {
    // The dropdown is presentation; this endpoint is reachable without it. A
    // rule naming a field that does not exist would sit there looking correct
    // and never match anything, so it is refused at the door.
    for (const rule of workflows) {
      if (!rule.trigger.startsWith('lead.')) continue;
      for (const condition of rule.conditions) {
        const check = await validateLeadCondition(condition.field, condition.op);
        if (!check.ok) {
          throw new ValidationError(`Automation “${rule.name}”: ${check.reason}`);
        }
      }
    }

    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId() },
      select: { settings: true },
    });
    const settings = (org.settings as Record<string, unknown>) ?? {};
    await prisma.organization.update({
      where: { id: orgId() },
      data: { settings: { ...settings, workflows } },
    });
    return workflows;
  },

  /**
   * Fire a trigger. If a queue is configured the work is handed to the worker
   * process (carrying the tenant context); otherwise it runs inline. Never throws.
   */
  async dispatch(trigger: Trigger, payload: Payload, target: Target): Promise<void> {
    const ctx = requestContext.get();
    const queued = await enqueue('workflow', 'dispatch', {
      trigger,
      payload,
      target,
      ctx: { organizationId: ctx?.organizationId, userId: ctx?.userId },
    });
    if (!queued) await this.dispatchNow(trigger, payload, target);
  },

  /** The actual evaluation + action execution (called inline or by the worker). */
  async dispatchNow(trigger: Trigger, payload: Payload, target: Target): Promise<void> {
    try {
      const rules = (await readWorkflows()).filter((r) => r.enabled && r.trigger === trigger);
      for (const rule of rules) {
        const matches = rule.conditions.every((c) => evalCondition(payload, c));
        if (!matches) continue;
        // Every action's outcome is recorded, successful or not: an automation
        // that quietly stopped working is worse than one that visibly failed.
        const results: { action: string; ok: boolean; error?: string }[] = [];
        for (const action of rule.actions) {
          try {
            await runAction(action, payload, target);
            results.push({ action: action.type, ok: true });
          } catch (err) {
            const message = (err as Error).message;
            logger.error({ err, rule: rule.name, action: action.type }, 'workflow action failed');
            results.push({ action: action.type, ok: false, error: message });
          }
        }

        const failed = results.filter((r) => !r.ok);
        await activityService.record({
          type: 'SYSTEM',
          entityType: target.entityType,
          entityId: target.entityId,
          title: failed.length
            ? `⚙️ Automation ran with errors — ${rule.name}`
            : `⚙️ Automation ran — ${rule.name}`,
          body: results
            .map((r) => `${r.action}: ${r.ok ? 'SUCCESS' : `FAILED — ${r.error}`}`)
            .join('\n'),
          metadata: {
            automation: rule.name,
            automationId: rule.id,
            trigger,
            results,
            failedCount: failed.length,
            ranAt: new Date().toISOString(),
          },
        });
      }
    } catch (err) {
      logger.error({ err, trigger }, 'workflow dispatch failed');
    }
  },
};
