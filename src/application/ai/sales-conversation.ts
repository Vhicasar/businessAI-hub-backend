export type CatalogItem = {
  productId: string;
  variantId: string;
  name: string;
  description?: string | null;
  price: number;
  currency: string;
  available: number;
  /** False for inactive, unpublished, internal-only or otherwise ineligible records. */
  purchasable?: boolean;
};

export type RequestedItem = {
  key: string;
  phrase: string;
  quantity: number;
  unit?: string;
};

export type SalesLine = RequestedItem & {
  status: 'RESOLVED' | 'AMBIGUOUS' | 'NOT_FOUND' | 'UNAVAILABLE';
  resolved?: CatalogItem;
  candidates?: CatalogItem[];
};

export type SalesFlowState = {
  version: 1;
  status: 'COLLECTING' | 'AWAITING_CLARIFICATION' | 'AWAITING_CONFIRMATION' | 'PROCESSING' | 'COMPLETED' | 'CANCELLED';
  lines: SalesLine[];
  lastQuestionKey?: string;
  lastQuestionFingerprint?: string;
  clarificationAttempts: number;
  updatedAt: string;
  sourceMessageId?: string;
  orderId?: string;
  orderNumber?: string;
};

export type ContextualSalesResolution = {
  handled: boolean;
  flow?: SalesFlowState;
  response?: string;
  needsPreviousOrder?: boolean;
};

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, dozen: 12,
};

function quantityValue(value: string): number | null {
  const normalized = normalizeProductText(value);
  if (/^\d+$/.test(normalized)) return Math.max(1, Math.min(9999, Number(normalized)));
  return NUMBER_WORDS[normalized] ?? null;
}

const UNITS = new Set([
  'plate', 'plates', 'piece', 'pieces', 'pack', 'packs', 'packet', 'packets',
  'bottle', 'bottles', 'bag', 'bags', 'cup', 'cups', 'tin', 'tins', 'box',
  'boxes', 'carton', 'cartons', 'kg', 'kilogram', 'kilograms', 'litre', 'litres',
  'liter', 'liters', 'unit', 'units', 'set', 'sets',
]);

export function normalizeProductText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function singular(value: string): string {
  if (value.endsWith('ies') && value.length > 4) return `${value.slice(0, -3)}y`;
  if (value.endsWith('ses') && value.length > 4) return value.slice(0, -2);
  if (value.endsWith('s') && !value.endsWith('ss') && value.length > 3) return value.slice(0, -1);
  return value;
}

function comparableTokens(value: string): string[] {
  return normalizeProductText(value).split(' ').filter(Boolean).map(singular);
}

function stripConversationWrapper(value: string): string {
  return value
    .replace(/^\s*(?:please\s+)?(?:i\s+(?:want|need|would like)(?:\s+to)?|can i (?:get|have)|give me|add|i'?ll take|order)\s+/i, '')
    .replace(/^\s*another\s+/i, '')
    .replace(/\s+(?:to|in)\s+my\s+(?:current\s+)?order\s*[.!?]*$/i, '')
    .replace(/[.!?]+$/g, '')
    .trim();
}

/** Remove customer-profile clauses before product segmentation. This is a
 * resilience fallback when semantic interpretation is unavailable; profile
 * data must never become a catalogue query. */
function stripProfileClauses(value: string): string {
  return value
    .replace(/^\s*(?:my name is|i am|i'm|this is)\s+[\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*)?\s*(?:,|;|\band\b)?\s*/iu, '')
    .replace(/^\s*(?:you can call me|call me)\s+[\p{L}][\p{L}'-]*\s*(?:,|;|\band\b)?\s*/iu, '')
    .trim();
}

/** Parse line items before any catalogue lookup. This prevents multiple items
 * from being mistaken for multiple candidates for one global search. */
export function extractRequestedItems(message: string): RequestedItem[] {
  const cleaned = stripConversationWrapper(stripProfileClauses(message));
  if (!cleaned) return [];
  const segments = cleaned
    .split(/\s*(?:,|;|\band\b|\bplus\b|\bthen\b)\s*/i)
    .map(stripConversationWrapper)
    .filter(Boolean);

  return segments.map((segment, index) => {
    const tokens = segment.split(/\s+/);
    let quantity = 1;
    const quantityToken = normalizeProductText(tokens[0] ?? '');
    if (/^\d+(?:\.\d+)?$/.test(quantityToken)) {
      quantity = Math.max(1, Math.min(9999, Math.floor(Number(quantityToken))));
      tokens.shift();
    } else if (NUMBER_WORDS[quantityToken]) {
      quantity = NUMBER_WORDS[quantityToken]!;
      tokens.shift();
    }

    let unit: string | undefined;
    const possibleUnit = normalizeProductText(tokens[0] ?? '');
    if (UNITS.has(possibleUnit)) {
      unit = singular(possibleUnit);
      tokens.shift();
      if (normalizeProductText(tokens[0] ?? '') === 'of') tokens.shift();
    }
    const phrase = tokens.join(' ').trim();
    return { key: `line-${index + 1}`, phrase, quantity, ...(unit ? { unit } : {}) };
  }).filter((item) => item.phrase.length > 0);
}

function matchScore(phrase: string, item: CatalogItem): number {
  const query = normalizeProductText(phrase);
  const name = normalizeProductText(item.name);
  if (!query || !name) return 0;
  if (query === name) return 1;
  const queryTokens = comparableTokens(query);
  const nameTokens = comparableTokens(name);
  const querySet = new Set(queryTokens);
  const nameSet = new Set(nameTokens);
  if (queryTokens.length > 0 && queryTokens.every((token) => nameSet.has(token))) return 0.94;
  if (nameTokens.length > 0 && nameTokens.every((token) => querySet.has(token))) return 0.92;
  const descriptionSet = new Set(comparableTokens(item.description ?? ''));
  const overlap = queryTokens.filter((token) => nameSet.has(token)).length;
  if (overlap > 0) return 0.65 + 0.25 * (overlap / Math.max(queryTokens.length, nameTokens.length));
  const descriptionOverlap = queryTokens.filter((token) => descriptionSet.has(token)).length;
  if (descriptionOverlap === queryTokens.length && descriptionOverlap > 0) return 0.62;
  // Conservative typo tolerance: only a single-token request and a single
  // close catalogue token. This fixes harmless spelling mistakes without
  // collapsing meaningful brand/size/flavour distinctions.
  if (queryTokens.length === 1) {
    const close = nameTokens.some((token) => editDistance(queryTokens[0]!, token) <= (queryTokens[0]!.length >= 6 ? 2 : 1));
    if (close) return 0.84;
  }
  return 0;
}

function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const previous = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[right.length]!;
}

export function resolveRequestedItem(request: RequestedItem, catalog: CatalogItem[]): SalesLine {
  const seen = new Set<string>();
  const ranked = catalog
    .filter((item) => item.purchasable !== false)
    .map((item) => ({ item, score: matchScore(request.phrase, item) }))
    .filter(({ score }) => score >= 0.62)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    // Search joins and caches can yield the same record more than once. Keep
    // materially different variants, but collapse duplicate representations.
    .filter(({ item }) => {
      const key = [item.productId, normalizeProductText(item.name), item.price, item.currency, item.available].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (!ranked.length) return { ...request, status: 'NOT_FOUND' };

  const exact = ranked.filter(({ score }) => score === 1);
  if (exact.length) {
    const availableExact = exact.filter(({ item }) => item.available > 0);
    if (availableExact.length > 1) {
      return { ...request, status: 'AMBIGUOUS', candidates: availableExact.slice(0, 6).map(({ item }) => item) };
    }
    const selected = availableExact[0]?.item ?? exact[0]!.item;
    return selected.available < request.quantity
      ? { ...request, status: 'UNAVAILABLE', resolved: selected }
      : { ...request, status: 'RESOLVED', resolved: selected };
  }

  const topScore = ranked[0]!.score;
  if (topScore < 0.72) return { ...request, status: 'NOT_FOUND' };
  const similarlyPlausible = ranked.filter(({ item, score }) => item.available > 0 && score >= Math.max(0.72, topScore - 0.08));
  if (similarlyPlausible.length > 1) {
    return { ...request, status: 'AMBIGUOUS', candidates: similarlyPlausible.slice(0, 6).map(({ item }) => item) };
  }
  const selected = similarlyPlausible[0]?.item ?? ranked[0]!.item;
  return selected.available < request.quantity
    ? { ...request, status: 'UNAVAILABLE', resolved: selected }
    : { ...request, status: 'RESOLVED', resolved: selected };
}

export function resolveRequestedItems(requests: RequestedItem[], catalog: CatalogItem[]): SalesLine[] {
  return requests.map((request) => resolveRequestedItem(request, catalog));
}

/**
 * One purchasable variant is one cart line. Context merges and model retries
 * can re-introduce an already-resolved item; retaining both makes final
 * validation compare duplicate proposal rows with one database variant. Keep
 * the latest intended representation and the greatest stated quantity rather
 * than silently doubling the customer's order.
 */
export function normalizeSalesLines(lines: SalesLine[]): SalesLine[] {
  const output: SalesLine[] = [];
  const resolvedByVariant = new Map<string, number>();
  for (const line of lines) {
    const variantId = line.status === 'RESOLVED' ? line.resolved?.variantId : undefined;
    if (!variantId) {
      output.push(line);
      continue;
    }
    const existingIndex = resolvedByVariant.get(variantId);
    if (existingIndex === undefined) {
      resolvedByVariant.set(variantId, output.length);
      output.push(line);
      continue;
    }
    const existing = output[existingIndex]!;
    output[existingIndex] = {
      ...line,
      key: existing.key,
      quantity: Math.max(existing.quantity, line.quantity),
    };
  }
  return output;
}

export function beginSalesFlow(
  requests: RequestedItem[], catalog: CatalogItem[], sourceMessageId?: string,
): SalesFlowState {
  const lines = resolveRequestedItems(requests, catalog);
  return finalizeState(lines, 0, sourceMessageId);
}

function finalizeState(lines: SalesLine[], attempts: number, sourceMessageId?: string): SalesFlowState {
  lines = normalizeSalesLines(lines);
  const unresolved = lines.find((line) => line.status !== 'RESOLVED');
  return {
    version: 1,
    status: unresolved ? 'AWAITING_CLARIFICATION' : 'AWAITING_CONFIRMATION',
    lines,
    ...(unresolved ? { lastQuestionKey: unresolved.key } : {}),
    clarificationAttempts: attempts,
    updatedAt: new Date().toISOString(),
    ...(sourceMessageId ? { sourceMessageId } : {}),
  };
}

/** Merge a clarification into only the unresolved line. A complete multi-line
 * restatement is re-resolved as a whole while retaining already-resolved lines
 * that the customer did not replace. */
export function advanceSalesFlow(
  state: SalesFlowState,
  message: string,
  catalog: CatalogItem[],
  sourceMessageId?: string,
): SalesFlowState {
  const unresolvedIndex = state.lines.findIndex((line) => line.status !== 'RESOLVED');
  const optionNumber = Number(message.trim().match(/^(\d+)\s*[.!]?$/)?.[1] ?? 0);
  if (unresolvedIndex >= 0 && optionNumber > 0) {
    const previous = state.lines[unresolvedIndex]!;
    const selected = previous.candidates?.[optionNumber - 1];
    if (selected) {
      const lines = [...state.lines];
      lines[unresolvedIndex] = selected.available < previous.quantity
        ? { ...previous, status: 'UNAVAILABLE', resolved: selected, candidates: undefined }
        : { ...previous, phrase: selected.name, status: 'RESOLVED', resolved: selected, candidates: undefined };
      return finalizeState(lines, state.clarificationAttempts + 1, sourceMessageId);
    }
  }
  const extracted = extractRequestedItems(message);
  if (!extracted.length) return { ...state, clarificationAttempts: state.clarificationAttempts + 1, updatedAt: new Date().toISOString() };

  if (extracted.length === 1 && unresolvedIndex >= 0) {
    const previous = state.lines[unresolvedIndex]!;
    const answer = extracted[0]!;
    const nextRequest: RequestedItem = {
      ...answer,
      key: previous.key,
      quantity: answer.quantity === 1 && !/^\s*(?:1|one|a|an)\b/i.test(stripConversationWrapper(message))
        ? previous.quantity
        : answer.quantity,
      unit: answer.unit ?? previous.unit,
    };
    const lines = [...state.lines];
    lines[unresolvedIndex] = resolveRequestedItem(nextRequest, catalog);
    return finalizeState(lines, state.clarificationAttempts + 1, sourceMessageId);
  }

  const incoming = resolveRequestedItems(extracted, catalog);
  const incomingResolvedIds = new Set(incoming.map((line) => line.resolved?.productId).filter(Boolean));
  const retained = state.lines.filter((line) => line.status === 'RESOLVED' && !incomingResolvedIds.has(line.resolved?.productId));
  return finalizeState([...incoming, ...retained], state.clarificationAttempts + 1, sourceMessageId);
}

/** Apply clear edits to a fully resolved proposal without asking the customer
 * to repeat the whole order. Returns null when the reference is not safe to
 * interpret deterministically. */
export function reviseConfirmedSalesFlow(
  state: SalesFlowState,
  message: string,
  catalog: CatalogItem[],
  sourceMessageId?: string,
): SalesFlowState | null {
  if (state.status !== 'AWAITING_CONFIRMATION') return null;
  const singleChange = message.match(/\bmake that\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i);
  if (singleChange && state.lines.length === 1) {
    const quantity = quantityValue(singleChange[1]!);
    if (!quantity) return null;
    const current = state.lines[0]!;
    return finalizeState([resolveRequestedItem({ ...current, quantity }, catalog)], state.clarificationAttempts, sourceMessageId);
  }

  const ordinalPattern = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:of\s+)?(?:the\s+)?(first|second|third)\s+(?:item|one)\b/gi;
  const ordinals: Record<string, number> = { first: 0, second: 1, third: 2 };
  const lines = [...state.lines];
  let ordinalChanged = false;
  for (const match of message.matchAll(ordinalPattern)) {
    const quantity = quantityValue(match[1]!);
    const index = ordinals[match[2]!.toLowerCase()];
    if (!quantity || index === undefined || !lines[index]) continue;
    lines[index] = resolveRequestedItem({ ...lines[index]!, quantity }, catalog);
    ordinalChanged = true;
  }
  if (ordinalChanged) return finalizeState(lines, state.clarificationAttempts, sourceMessageId);

  if (/\badd\s+(?:another\s+)?/i.test(message)) {
    const additions = resolveRequestedItems(extractRequestedItems(message), catalog);
    if (!additions.length || additions.some((line) => line.status !== 'RESOLVED')) return null;
    const merged = [...state.lines];
    for (const addition of additions) {
      const existingIndex = merged.findIndex((line) => line.resolved?.variantId === addition.resolved?.variantId);
      if (existingIndex >= 0) {
        const existing = merged[existingIndex]!;
        merged[existingIndex] = resolveRequestedItem({ ...existing, quantity: existing.quantity + addition.quantity }, catalog);
      } else merged.push(addition);
    }
    return finalizeState(merged, state.clarificationAttempts, sourceMessageId);
  }
  return null;
}

/** Resolve action/reference language before entity extraction or catalogue
 * search. This is the shared channel-independent boundary that prevents words
 * such as "place another one" from becoming a product-name query. */
export function resolveContextualSalesReference(
  state: SalesFlowState | null,
  message: string,
  catalog: CatalogItem[],
  sourceMessageId?: string,
): ContextualSalesResolution {
  const value = normalizeProductText(message);
  const previousOrder = /\b(same|repeat|reorder)\b.*\b(order|purchase)\b|\bwhat i (bought|ordered)\b|\border\b.*\b(last time|yesterday|again)\b/.test(value);
  if (previousOrder) return { handled: true, needsPreviousOrder: true };

  const option = value.match(/\b(first|second|third)\s+(?:one|option|item)\b/);
  if (option && state?.status === 'AWAITING_CLARIFICATION') {
    const number = { first: 1, second: 2, third: 3 }[option[1] as 'first' | 'second' | 'third'];
    return { handled: true, flow: advanceSalesFlow(state, String(number), catalog, sourceMessageId) };
  }

  const quantityChange = value.match(/\bmake (?:that|it)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/);
  if (quantityChange && state?.status === 'AWAITING_CONFIRMATION') {
    if (state.lines.length !== 1) {
      return { handled: true, response: `Which item should be changed to ${quantityChange[1]}? ${state.lines.map((line) => line.resolved?.name).filter(Boolean).join(', ')}.` };
    }
    const revised = reviseConfirmedSalesFlow(state, `make that ${quantityChange[1]}`, catalog, sourceMessageId);
    return revised ? { handled: true, flow: revised } : { handled: true, response: 'I could not safely apply that quantity. Which item and quantity do you mean?' };
  }

  const contextualRepeat = /\b(another|same thing|same one|that one|it)\b/.test(value)
    && /\b(place|order|want|give|get|add|take|have)\b/.test(value);
  if (!contextualRepeat) return { handled: false };
  if (!state || state.status === 'CANCELLED') {
    return { handled: true, response: "Of course! Would you like to reorder something you've bought before, or choose a new product?" };
  }
  if (state.status === 'COMPLETED') {
    const requests = state.lines.map((line, index) => ({
      key: `line-${index + 1}`, phrase: line.resolved?.name ?? line.phrase, quantity: line.quantity, unit: line.unit,
    }));
    return { handled: true, flow: beginSalesFlow(requests, catalog, sourceMessageId) };
  }
  if (state.status === 'AWAITING_CLARIFICATION') {
    return { handled: true, response: `Which option do you mean for ${state.lines.find((line) => line.status !== 'RESOLVED')?.phrase ?? 'that item'}? Please reply with its number or full name.` };
  }
  if (state.status === 'AWAITING_CONFIRMATION') {
    if (state.lines.length !== 1) {
      return { handled: true, response: `Which item do you want another of: ${state.lines.map((line) => line.resolved?.name).filter(Boolean).join(', ')}?` };
    }
    const line = state.lines[0]!;
    const amountMatch = value.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+more\b/);
    const extra = amountMatch ? quantityValue(amountMatch[1]!) ?? 1 : 1;
    const next = resolveRequestedItem({ ...line, quantity: line.quantity + extra }, catalog);
    return { handled: true, flow: finalizeState([next], state.clarificationAttempts, sourceMessageId) };
  }
  return { handled: true, response: 'That purchase is currently being processed. I will not create a duplicate.' };
}

export function stateFingerprint(line: SalesLine): string {
  return JSON.stringify({ key: line.key, phrase: normalizeProductText(line.phrase), status: line.status, candidates: line.candidates?.map((candidate) => candidate.productId) ?? [] });
}
