import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { getAiProvider } from '../../infrastructure/ai';
import { extractJson } from '../ai/ai-provider';

/**
 * Marketing "designs" — a Canva-style free-form canvas. Each design is a set of
 * absolutely-positioned elements ({ id, type, x, y, w, h, rotation, z, props })
 * stored as JSON. The frontend editor renders/edits them; export (HTML/SVG/PNG)
 * is done client-side from the same element model.
 */

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new ValidationError('No tenant in context');
  return id;
}

export const createDesignSchema = z.object({
  name: z.string().trim().min(1).max(120).default('Untitled design'),
  width: z.number().int().min(100).max(5000).optional(),
  height: z.number().int().min(100).max(5000).optional(),
  template: z.string().optional(),
});
export const updateDesignSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  width: z.number().int().min(100).max(5000).optional(),
  height: z.number().int().min(100).max(5000).optional(),
  background: z.string().max(40).optional(),
  elements: z.array(z.record(z.unknown())).optional(),
});

type El = { id: string; type: string; x: number; y: number; w: number; h: number; rotation: number; z: number; props: Record<string, unknown> };
const mk = (type: string, x: number, y: number, w: number, h: number, props: Record<string, unknown>, z = 1): El =>
  ({ id: `el_${Math.random().toString(36).slice(2, 9)}`, type, x, y, w, h, rotation: 0, z, props });

const TEMPLATES: Record<string, () => El[]> = {
  blank: () => [],
  sale: () => [
    mk('shape', 0, 0, 1080, 1350, { shape: 'rect', fill: '#0f172a' }, 0),
    mk('text', 90, 200, 900, 220, { text: 'MEGA SALE', fontSize: 130, color: '#F97316', fontWeight: 800, align: 'center' }, 1),
    mk('text', 90, 470, 900, 120, { text: 'Up to 50% off — this weekend only', fontSize: 44, color: '#ffffff', align: 'center' }, 2),
    mk('button', 390, 1080, 300, 96, { text: 'Shop now', bg: '#F97316', color: '#ffffff', fontSize: 36, radius: 999 }, 3),
  ],
  event: () => [
    mk('shape', 0, 0, 1080, 1350, { shape: 'rect', fill: '#F97316' }, 0),
    mk('text', 90, 160, 900, 100, { text: 'YOU’RE INVITED', fontSize: 56, color: '#ffffff', fontWeight: 800, align: 'center' }, 1),
    mk('text', 90, 520, 900, 200, { text: 'Our Grand Opening', fontSize: 96, color: '#0f172a', fontWeight: 800, align: 'center' }, 2),
    mk('text', 90, 780, 900, 90, { text: 'Saturday · 10am — 4pm', fontSize: 44, color: '#0f172a', align: 'center' }, 3),
    mk('button', 340, 1080, 400, 96, { text: 'RSVP now', bg: '#0f172a', color: '#ffffff', fontSize: 36, radius: 16 }, 4),
  ],
};

export const designService = {
  list: () =>
    prisma.design.findMany({
      orderBy: { updatedAt: 'desc' },
      select: { id: true, name: true, width: true, height: true, background: true, elements: true, updatedAt: true },
    }),

  async get(id: string) {
    const d = await prisma.design.findFirst({ where: { id } });
    if (!d) throw new NotFoundError('Design');
    return d;
  },

  async create(dto: z.infer<typeof createDesignSchema>) {
    const build = TEMPLATES[dto.template ?? 'blank'] ?? TEMPLATES.blank ?? (() => [] as El[]);
    const elements = build();
    return prisma.design.create({
      data: {
        organizationId: orgId(),
        name: dto.name,
        width: dto.width ?? 1080,
        height: dto.height ?? 1350,
        elements: elements as object,
      },
    });
  },

  async update(id: string, dto: z.infer<typeof updateDesignSchema>) {
    await this.get(id);
    return prisma.design.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.width !== undefined ? { width: dto.width } : {}),
        ...(dto.height !== undefined ? { height: dto.height } : {}),
        ...(dto.background !== undefined ? { background: dto.background } : {}),
        ...(dto.elements !== undefined ? { elements: dto.elements as object } : {}),
      },
    });
  },

  async remove(id: string) {
    await this.get(id);
    await prisma.design.delete({ where: { id } });
    return { deleted: true };
  },

  /** Generate a poster layout (headline, subheading, CTA + colors) from a brief. */
  async aiGenerate(id: string, prompt: string) {
    const provider = getAiProvider('design');
    const design = await this.get(id);
    if (!provider) throw new ValidationError('AI is not configured for this workspace');
    const raw = await provider.complete(
      [
        {
          role: 'system',
          content:
            'You design marketing posters. Given a brief, return JSON only: ' +
            '{"bg":"#hex","headline":"...","subheading":"...","cta":"...","headlineColor":"#hex","textColor":"#hex","ctaBg":"#hex"}. ' +
            'Punchy, specific copy. Headline ≤ 4 words, subheading ≤ 12 words, cta ≤ 3 words.',
        },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 300, temperature: 0.7, jsonMode: true },
    );
    const g = extractJson<{ bg?: string; headline?: string; subheading?: string; cta?: string; headlineColor?: string; textColor?: string; ctaBg?: string }>(raw);
    if (!g?.headline) throw new ValidationError('The AI could not generate a design — try a clearer brief');
    const W = design.width, H = design.height;
    const elements: El[] = [
      mk('shape', 0, 0, W, H, { shape: 'rect', fill: g.bg || '#0f172a' }, 0),
      mk('text', W * 0.08, H * 0.16, W * 0.84, H * 0.18, { text: g.headline, fontSize: Math.round(W * 0.11), color: g.headlineColor || '#F97316', fontWeight: 800, align: 'center' }, 1),
      ...(g.subheading ? [mk('text', W * 0.08, H * 0.38, W * 0.84, H * 0.1, { text: g.subheading, fontSize: Math.round(W * 0.04), color: g.textColor || '#ffffff', align: 'center' }, 2)] : []),
      ...(g.cta ? [mk('button', W * 0.32, H * 0.8, W * 0.36, H * 0.07, { text: g.cta, bg: g.ctaBg || '#F97316', color: '#ffffff', fontSize: Math.round(W * 0.032), radius: 999 }, 3)] : []),
    ];
    return prisma.design.update({ where: { id }, data: { background: g.bg || design.background, elements: elements as object } });
  },
};
