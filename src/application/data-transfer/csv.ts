/**
 * Minimal RFC 4180 CSV codec. Pure and dependency-free so the parsing rules
 * (quotes, escaped quotes, embedded newlines, CRLF) are unit-testable.
 */

/** Parse CSV text into rows of raw cell strings. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let started = false; // did this row have any content at all?

  // Strip a UTF-8 BOM — Excel and Google Sheets both emit one.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    // Ignore blank trailing lines.
    if (!(row.length === 1 && row[0]!.trim() === '' && !started)) rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"'; // escaped quote
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      started = true;
      continue;
    }
    if (c === ',') {
      started = true;
      endField();
      continue;
    }
    if (c === '\r') {
      if (src[i + 1] === '\n') i++;
      endRow();
      continue;
    }
    if (c === '\n') {
      endRow();
      continue;
    }
    if (c.trim() !== '') started = true;
    field += c;
  }
  // Flush the last field/row unless the file ended on a newline.
  if (field !== '' || row.length > 0) endRow();

  // Drop rows that are entirely empty (e.g. a trailing "\n\n").
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/** Escape one cell for CSV output. */
function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = value instanceof Date ? value.toISOString() : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialise objects to CSV using the given column order. */
export function toCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const lines = [headers.map(escapeCell).join(',')];
  for (const r of rows) lines.push(headers.map((h) => escapeCell(r[h])).join(','));
  return lines.join('\r\n');
}

/**
 * Normalise a header for fuzzy matching: lowercase, drop bracketed hints
 * (Google Workspace emits "First Name [Required]") and all non-alphanumerics.
 */
export function normHeader(h: string): string {
  return h.toLowerCase().replace(/\[.*?\]/g, '').replace(/[^a-z0-9]/g, '');
}

/** Turn parsed rows into keyed records using normalised headers. */
export function toRecords(rows: string[][]): Record<string, string>[] {
  if (rows.length === 0) return [];
  const headers = (rows[0] ?? []).map(normHeader);
  return rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h) rec[h] = (r[i] ?? '').trim();
    });
    return rec;
  });
}

/** First non-empty value among the given header aliases. */
export function pick(rec: Record<string, string>, ...aliases: string[]): string | undefined {
  for (const a of aliases) {
    const v = rec[normHeader(a)];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

/** Split a single "full name" column into first/last. */
export function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') };
}
