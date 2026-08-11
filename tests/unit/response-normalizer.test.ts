import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { normalizeResponse } from '../../src/presentation/http/middleware/response-normalizer';

/**
 * The normaliser exists so a client never has to defend against a null
 * collection. It must not "help" with anything else.
 *
 * It previously decided what was a collection from the *shape of the name* —
 * anything ending in "s" — which quietly turned every nullable scalar with a
 * plural-looking name into an array. `notes: null` came back as `[]`, and the
 * invoice printer threw on it, so businesses could not print or download an
 * invoice at all. `bedrooms`, `weightGrams`, `paymentTerms` and `address` were
 * corrupted the same way.
 */
function send(path: string, body: unknown): unknown {
  const req = { path } as Request;
  let captured: unknown;
  const res = {
    json: ((value: unknown) => {
      captured = value;
      return res;
    }) as Response['json'],
  } as Response;

  normalizeResponse(req, res, vi.fn());
  res.json(body);
  return captured;
}

describe('response normalizer', () => {
  describe('leaves scalars alone', () => {
    // Every one of these is a nullable scalar in the schema whose name ends
    // in "s". They are the reason the old heuristic was unsafe.
    const scalars = [
      'notes',
      'address',
      'ipAddress',
      'bedrooms',
      'bathrooms',
      'weightGrams',
      'paymentTerms',
      'terms',
      'instructions',
      'preferences',
      'settings',
      'maxUsers',
      'leadTimeDays',
      'expiryMonths',
      'comments',
      'credentials',
      'stats',
    ];

    for (const field of scalars) {
      it(`${field} stays null`, () => {
        const out = send('/api/v1/invoices/abc', {
          success: true,
          data: { id: 'abc', [field]: null },
        }) as { data: Record<string, unknown> };
        expect(out.data[field]).toBeNull();
      });
    }

    it('a null note is not turned into something a text field cannot render', () => {
      const out = send('/api/v1/invoices/abc', {
        success: true,
        data: { number: 'INV-1', notes: null },
      }) as { data: { notes: unknown } };
      // The specific regression: `[]` here is what broke printing.
      expect(Array.isArray(out.data.notes)).toBe(false);
    });
  });

  describe('still fills in real collections', () => {
    it('a null relation list becomes an empty array', () => {
      const out = send('/api/v1/invoices/abc', {
        success: true,
        data: { id: 'abc', items: null, payments: null, tags: null },
      }) as { data: Record<string, unknown> };
      expect(out.data.items).toEqual([]);
      expect(out.data.payments).toEqual([]);
      expect(out.data.tags).toEqual([]);
    });

    it('a collection route that produced nothing returns a list', () => {
      const out = send('/api/v1/customers/search', { success: true, data: null }) as {
        data: unknown;
      };
      expect(out.data).toEqual([]);
    });

    it('a paginated shape always carries both keys', () => {
      const out = send('/api/v1/orders', { success: true, data: { items: null } }) as {
        data: { items: unknown; pagination: unknown };
      };
      expect(out.data.items).toEqual([]);
      expect(out.data.pagination).toEqual({});
    });
  });

  describe('never rewrites real data', () => {
    it('a populated list is untouched', () => {
      const out = send('/api/v1/invoices/abc', {
        success: true,
        data: { items: [{ id: '1' }] },
      }) as { data: { items: unknown[] } };
      expect(out.data.items).toHaveLength(1);
    });

    it('a real note survives', () => {
      const out = send('/api/v1/invoices/abc', {
        success: true,
        data: { notes: 'Deliver to the back entrance' },
      }) as { data: { notes: string } };
      expect(out.data.notes).toBe('Deliver to the back entrance');
    });

    it('an error envelope is left completely alone', () => {
      const body = { success: false, data: null, error: { code: 'NOPE' } };
      expect(send('/api/v1/customers/search', body)).toEqual(body);
    });
  });
});
