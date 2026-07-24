import { normHeader } from './csv';
import { detectColumn, type ColumnDetection, type DetectedType } from './detect';
import type { FieldDef } from './fields';

/**
 * Suggests which target field each CSV column belongs to, combining two signals:
 * what the header says, and what the data actually looks like. Content wins when
 * a header is missing, cryptic, or lying. Pure — the heuristics are testable.
 */

export interface ColumnAnalysis {
  index: number;
  header: string;
  samples: string[];
  detected: ColumnDetection;
  suggestedField: string | null;
}

/** Distinctive types are strong evidence on their own; text/number are weak. */
function contentWeight(t: DetectedType): number {
  if (t === 'email' || t === 'phone' || t === 'url') return 55;
  if (t === 'date' || t === 'currency' || t === 'boolean') return 40;
  // "Ada Lovelace" is distinctive enough to carry a column on its own when the
  // header is junk — must clear MIN_SCORE unaided.
  if (t === 'fullName') return 35;
  return 12; // text, number — too generic to mean much alone
}

/** Minimum evidence before we'll suggest a mapping at all. */
const MIN_SCORE = 30;

/** Score one column against one field. */
export function scoreColumn(header: string, detected: ColumnDetection, field: FieldDef): number {
  const h = normHeader(header);
  let s = 0;
  let match: 'exact' | 'partial' | 'none' = 'none';

  if (h) {
    const targets = [field.key, ...field.aliases].map(normHeader).filter(Boolean);
    if (targets.includes(h)) {
      s += 100;
      match = 'exact';
    } else if (targets.some((t) => h.includes(t) || t.includes(h))) {
      s += 55;
      match = 'partial';
    }
  }

  const contentMatches = field.accepts.includes(detected.type);
  if (contentMatches) {
    s += contentWeight(detected.type) * detected.confidence;
  } else if (match === 'exact') {
    // The column is explicitly labelled. A human naming it beats content
    // sniffing, so an exact match is authoritative even if the data looks odd.
    s -= 5;
  } else if (match === 'partial') {
    s -= 20; // fuzzy header AND disagreeing content — weak candidate
  } else {
    return 0; // no evidence at all
  }

  // A mostly-empty column is a weak candidate.
  s *= 1 - detected.emptyRatio * 0.5;
  return Math.round(s);
}

/**
 * Analyse every column and greedily assign the best (column, field) pairs.
 * Each field is claimed at most once, so two columns never fight for one target.
 */
export function analyzeColumns(headers: string[], columns: string[][], fields: FieldDef[]): ColumnAnalysis[] {
  const analyses: ColumnAnalysis[] = headers.map((header, index) => {
    const values = columns[index] ?? [];
    return {
      index,
      header,
      samples: values.filter((v) => (v ?? '').trim() !== '').slice(0, 3),
      detected: detectColumn(values),
      suggestedField: null,
    };
  });

  const pairs: { col: number; field: string; s: number }[] = [];
  for (const a of analyses) {
    for (const f of fields) {
      const s = scoreColumn(a.header, a.detected, f);
      if (s >= MIN_SCORE) pairs.push({ col: a.index, field: f.key, s });
    }
  }
  // Highest score first; ties broken by column order for stable output.
  pairs.sort((x, y) => y.s - x.s || x.col - y.col);

  const takenField = new Set<string>();
  const takenCol = new Set<number>();
  for (const p of pairs) {
    if (takenField.has(p.field) || takenCol.has(p.col)) continue;
    takenField.add(p.field);
    takenCol.add(p.col);
    analyses[p.col]!.suggestedField = p.field;
  }
  return analyses;
}

/** Transpose parsed rows (excluding the header) into per-column value arrays. */
export function toColumns(rows: string[][], headerCount: number): string[][] {
  const cols: string[][] = Array.from({ length: headerCount }, () => []);
  for (const row of rows) {
    for (let i = 0; i < headerCount; i++) cols[i]!.push(row[i] ?? '');
  }
  return cols;
}
