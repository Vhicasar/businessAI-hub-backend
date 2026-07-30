import { PDFParse } from 'pdf-parse';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { logger } from '../../shared/logger';
import { getAiProvider } from '../../infrastructure/ai';
import type { AiMessage } from '../ai/ai-provider';

/** Extract plain text from an uploaded document (PDF, or text/markdown/csv). */
export async function extractDocumentText(buffer: Buffer, mimetype: string, filename: string): Promise<string> {
  const name = filename.toLowerCase();
  if (mimetype === 'application/pdf' || name.endsWith('.pdf')) {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      // Drop pdf-parse's "-- N of M --" page separators; keep the prose.
      return (result.text ?? '').replace(/\n?-- \d+ of \d+ --\n?/g, '\n').replace(/\s+\n/g, '\n').trim();
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }
  if (mimetype.startsWith('text/') || /\.(txt|md|markdown|csv)$/.test(name)) {
    return buffer.toString('utf8').trim();
  }
  throw new Error('Unsupported file type — upload a PDF, TXT, Markdown, or CSV file');
}

/**
 * The AI knowledge base: ingests a business's website + documents into
 * retrievable chunks, and answers questions grounded in that content (RAG).
 *
 * Retrieval is Postgres full-text by default (no embeddings cost). A semantic
 * path can be layered on later behind an admin toggle. All methods take an
 * explicit organizationId so ingestion can run in the background, outside a
 * request's tenant context.
 */

const MAX_PAGES = 6;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_HTML_BYTES = 2_000_000;
const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 120;

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchPage(url: string): Promise<{ text: string; links: string[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'VhicasarHubAI-KnowledgeBot/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = (await res.text()).slice(0, MAX_HTML_BYTES);
    const links = [...html.matchAll(/href=["']([^"'#]+)["']/gi)]
      .map((m) => m[1])
      .filter((h): h is string => typeof h === 'string');
    return { text: htmlToText(html), links };
  } finally {
    clearTimeout(timer);
  }
}

/** Shallow same-origin crawl (a handful of pages) into one text blob. */
async function crawl(startUrl: string): Promise<string> {
  const origin = new URL(startUrl).origin;
  const visited = new Set<string>();
  const queue = [startUrl];
  const texts: string[] = [];
  while (queue.length > 0 && visited.size < MAX_PAGES) {
    const raw = queue.shift();
    if (!raw) continue;
    const norm = raw.split('#')[0] ?? raw;
    if (visited.has(norm)) continue;
    visited.add(norm);
    try {
      const { text, links } = await fetchPage(norm);
      if (text) texts.push(text);
      for (const href of links) {
        try {
          const abs = new URL(href, norm);
          const clean = abs.href.split('#')[0] ?? abs.href;
          if (/^https?:$/.test(abs.protocol) && abs.origin === origin && !visited.has(clean)) queue.push(clean);
        } catch {
          /* skip malformed link */
        }
      }
    } catch (err) {
      logger.warn({ err, url: norm }, 'KB crawl: page failed');
    }
  }
  return texts.join('\n\n');
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
    chunks.push(text.slice(i, i + CHUNK_SIZE));
  }
  return chunks.map((c) => c.trim()).filter((c) => c.length > 40);
}

export interface AddSourceInput {
  type: 'URL' | 'TEXT' | 'DOCUMENT';
  title: string;
  url?: string;
  text?: string;
}

export const knowledgeService = {
  async list(orgId: string) {
    return prismaUnscoped.knowledgeSource.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
    });
  },

  /** Create a source and kick off ingestion in the background. */
  async addSource(orgId: string, input: AddSourceInput) {
    if (input.type === 'URL' && !/^https?:\/\//i.test(input.url ?? '')) {
      throw new Error('A valid http(s) URL is required');
    }
    const source = await prismaUnscoped.knowledgeSource.create({
      data: {
        organizationId: orgId,
        type: input.type,
        title: input.title,
        url: input.url ?? null,
        status: 'PENDING',
      },
    });
    void this.ingest(orgId, source.id, input.text).catch((err) =>
      logger.error({ err, sourceId: source.id }, 'KB ingest crashed'),
    );
    return source;
  },

  /** Fetch/parse a source, (re)build its chunks. Never throws to the caller. */
  async ingest(orgId: string, sourceId: string, rawText?: string) {
    const source = await prismaUnscoped.knowledgeSource.findFirst({ where: { id: sourceId, organizationId: orgId } });
    if (!source) return;
    try {
      await prismaUnscoped.knowledgeSource.update({ where: { id: sourceId }, data: { status: 'PENDING', error: null } });
      const text = source.type === 'URL' && source.url ? await crawl(source.url) : (rawText ?? '');
      const chunks = chunkText(text);
      if (chunks.length === 0) throw new Error('No readable content found');
      await prismaUnscoped.knowledgeChunk.deleteMany({ where: { sourceId } });
      await prismaUnscoped.knowledgeChunk.createMany({
        data: chunks.map((content, position) => ({ organizationId: orgId, sourceId, content, position })),
      });
      await prismaUnscoped.knowledgeSource.update({
        where: { id: sourceId },
        data: { status: 'READY', chunkCount: chunks.length, error: null },
      });
      logger.info({ sourceId, chunks: chunks.length }, 'KB source ingested');
    } catch (err) {
      await prismaUnscoped.knowledgeSource.update({
        where: { id: sourceId },
        data: { status: 'FAILED', error: (err as Error).message?.slice(0, 500) ?? 'Ingestion failed' },
      });
      logger.warn({ err, sourceId }, 'KB ingest failed');
    }
  },

  async reingest(orgId: string, sourceId: string, text?: string) {
    void this.ingest(orgId, sourceId, text).catch(() => undefined);
    return { queued: true };
  },

  async remove(orgId: string, id: string) {
    await prismaUnscoped.knowledgeSource.deleteMany({ where: { id, organizationId: orgId } });
    return { deleted: true };
  },

  /**
   * Full-text retrieval over an org's chunks. Uses OR semantics (any term)
   * ranked by relevance — plainto_tsquery ANDs every term, which misses a chunk
   * that lacks even one query word (e.g. "hours" when the text says "9am–7pm").
   */
  async search(orgId: string, query: string, limit = 5) {
    const terms = (query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).slice(0, 24);
    if (terms.length === 0) return [];
    const tsquery = terms.join(' | ');
    return prismaUnscoped.$queryRaw<
      Array<{ id: string; content: string; title: string; url: string | null; rank: number }>
    >`
      SELECT c.id, c.content, s.title, s.url,
             ts_rank(to_tsvector('english', c.content), to_tsquery('english', ${tsquery})) AS rank
      FROM "KnowledgeChunk" c
      JOIN "KnowledgeSource" s ON s.id = c."sourceId"
      WHERE c."organizationId" = ${orgId}
        AND to_tsvector('english', c.content) @@ to_tsquery('english', ${tsquery})
      ORDER BY rank DESC
      LIMIT ${limit}`;
  },

  /**
   * Answer a customer question grounded in the org's knowledge base.
   * Returns the answer plus the sources it drew on (empty when none matched).
   */
  async answer(
    orgId: string,
    question: string,
    history: AiMessage[] = [],
  ): Promise<{ answer: string | null; sources: { title: string; url: string | null }[]; grounded: boolean }> {
    const provider = getAiProvider();
    if (!provider) return { answer: null, sources: [], grounded: false };

    const hits = await this.search(orgId, question, 5);
    const org = await prismaUnscoped.organization.findUnique({ where: { id: orgId }, select: { name: true } });
    const context = hits.map((h, i) => `[${i + 1}] (${h.title})\n${h.content}`).join('\n\n');

    const system =
      `You are a friendly, concise assistant for ${org?.name ?? 'this business'}. ` +
      `Answer the customer's question using ONLY the CONTEXT below. If the answer is not in ` +
      `the context, say you don't have that information yet and offer to help another way or ` +
      `connect them to the team. Never invent facts, prices, or policies.\n\nCONTEXT:\n` +
      `${context || '(no relevant information found)'}`;

    const messages: AiMessage[] = [
      { role: 'system', content: system },
      ...history.slice(-6),
      { role: 'user', content: question },
    ];
    const answer = (await provider.complete(messages, { maxTokens: 400, temperature: 0.3 })).trim();
    const sources = [...new Map(hits.map((h) => [h.title, { title: h.title, url: h.url }])).values()];
    return { answer, sources, grounded: hits.length > 0 };
  },
};
