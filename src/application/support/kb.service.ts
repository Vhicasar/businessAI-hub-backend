import { z } from 'zod';
import { ConflictError, NotFoundError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'article';
}
async function uniqueSlug(base: string): Promise<string> {
  const s = slugify(base);
  const clash = await prisma.kbArticle.findFirst({ where: { slug: s } });
  return clash ? `${s}-${Date.now().toString(36).slice(-4)}` : s;
}

export const listArticlesSchema = z.object({
  categoryId: z.string().optional(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
  search: z.string().trim().max(120).optional(),
  publicOnly: z.coerce.boolean().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const createArticleSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(50000),
  categoryId: z.string().nullable().optional(),
  isPublic: z.boolean().default(true),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).default('DRAFT'),
});
export const updateArticleSchema = createArticleSchema.partial();
export const categorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: z.string().nullable().optional(),
});

const articleSelect = {
  id: true, title: true, slug: true, status: true, isPublic: true, categoryId: true,
  viewCount: true, helpfulCount: true, publishedAt: true, updatedAt: true,
} as const;

export const kbService = {
  // ------------------------------------------------------------ categories
  async listCategories() {
    return prisma.kbCategory.findMany({
      select: { id: true, name: true, slug: true, parentId: true, position: true },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
  },
  async createCategory(dto: z.infer<typeof categorySchema>) {
    return prisma.kbCategory.create({
      data: { organizationId: orgId(), name: dto.name, slug: slugify(dto.name), parentId: dto.parentId ?? null },
      select: { id: true, name: true, slug: true, parentId: true },
    });
  },
  async deleteCategory(id: string) {
    const inUse = await prisma.kbArticle.count({ where: { categoryId: id, deletedAt: null } });
    if (inUse > 0) throw new ConflictError('Category has articles — reassign them first');
    await prisma.kbCategory.deleteMany({ where: { id } });
    return { deleted: true };
  },

  // -------------------------------------------------------------- articles
  async listArticles(dto: z.infer<typeof listArticlesSchema>) {
    const rows = await prisma.kbArticle.findMany({
      where: {
        deletedAt: null,
        ...(dto.categoryId ? { categoryId: dto.categoryId } : {}),
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.publicOnly ? { isPublic: true, status: 'PUBLISHED' } : {}),
        ...(dto.search
          ? {
              OR: [
                { title: { contains: dto.search, mode: 'insensitive' as const } },
                { body: { contains: dto.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      select: articleSelect,
      orderBy: { updatedAt: 'desc' },
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > dto.limit;
    const items = hasMore ? rows.slice(0, dto.limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null };
  },

  async getArticle(id: string, countView = false) {
    const article = await prisma.kbArticle.findFirst({
      where: { id, deletedAt: null },
      select: { ...articleSelect, body: true },
    });
    if (!article) throw new NotFoundError('Article');
    if (countView) await prisma.kbArticle.update({ where: { id }, data: { viewCount: { increment: 1 } } });
    return article;
  },

  async createArticle(dto: z.infer<typeof createArticleSchema>) {
    return prisma.kbArticle.create({
      data: {
        organizationId: orgId(),
        title: dto.title,
        slug: await uniqueSlug(dto.title),
        body: dto.body,
        categoryId: dto.categoryId ?? null,
        isPublic: dto.isPublic,
        status: dto.status,
        authorUserId: requestContext.get()?.userId ?? null,
        publishedAt: dto.status === 'PUBLISHED' ? new Date() : null,
      },
      select: { ...articleSelect, body: true },
    });
  },

  async updateArticle(id: string, dto: z.infer<typeof updateArticleSchema>) {
    const existing = await prisma.kbArticle.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundError('Article');
    const publishing = dto.status === 'PUBLISHED' && existing.status !== 'PUBLISHED';
    return prisma.kbArticle.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.body !== undefined ? { body: dto.body } : {}),
        ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
        ...(dto.isPublic !== undefined ? { isPublic: dto.isPublic } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(publishing ? { publishedAt: new Date() } : {}),
      },
      select: { ...articleSelect, body: true },
    });
  },

  async deleteArticle(id: string) {
    const existing = await prisma.kbArticle.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundError('Article');
    await prisma.kbArticle.update({ where: { id }, data: { deletedAt: new Date() } });
    return { deleted: true };
  },

  /** Suggest relevant published articles for a query (deflect before ticketing). */
  async suggest(query: string, limit = 5) {
    const terms = query.trim().split(/\s+/).filter((t) => t.length > 2).slice(0, 6);
    const rows = await prisma.kbArticle.findMany({
      where: {
        deletedAt: null,
        status: 'PUBLISHED',
        ...(terms.length
          ? { OR: terms.flatMap((t) => [
              { title: { contains: t, mode: 'insensitive' as const } },
              { body: { contains: t, mode: 'insensitive' as const } },
            ]) }
          : {}),
      },
      select: { id: true, title: true, slug: true, categoryId: true },
      orderBy: { helpfulCount: 'desc' },
      take: limit,
    });
    return rows;
  },
};
