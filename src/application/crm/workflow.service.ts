import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { logger } from '../../shared/logger';
import { activityService } from './activity.service';
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
  field: z.string().trim().min(1).max(60),
  op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains']),
  value: z.string().max(200),
});
const actionSchema = z.object({
  type: z.enum(['create_task', 'add_note', 'notify', 'send_email', 'send_whatsapp', 'send_sms']),
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

function evalCondition(payload: Payload, c: z.infer<typeof conditionSchema>): boolean {
  const raw = payload[c.field];
  if (raw === undefined || raw === null) return false;
  const asNum = Number(raw);
  const cmpNum = Number(c.value);
  const numeric = !Number.isNaN(asNum) && !Number.isNaN(cmpNum);
  switch (c.op) {
    case 'eq':
      return String(raw).toLowerCase() === c.value.toLowerCase();
    case 'ne':
      return String(raw).toLowerCase() !== c.value.toLowerCase();
    case 'contains':
      return String(raw).toLowerCase().includes(c.value.toLowerCase());
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
        for (const action of rule.actions) {
          try {
            await runAction(action, payload, target);
          } catch (err) {
            logger.error({ err, rule: rule.name, action: action.type }, 'workflow action failed');
          }
        }
        await activityService.record({
          type: 'SYSTEM',
          entityType: target.entityType,
          entityId: target.entityId,
          title: `⚙️ Automation ran — ${rule.name}`,
        });
      }
    } catch (err) {
      logger.error({ err, trigger }, 'workflow dispatch failed');
    }
  },
};
