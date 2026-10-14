import { z } from 'zod';
import type { AiProvider } from './ai-provider';
import { extractJson } from './ai-provider';

const interpretationSchema = z.object({
  profile: z.object({ name: z.string().trim().min(1).max(120).optional() }).optional(),
  items: z.array(z.object({
    phrase: z.string().trim().min(1).max(160),
    quantity: z.coerce.number().int().min(1).max(9999),
    unit: z.string().trim().min(1).max(40).optional(),
  })).max(20).default([]),
  actions: z.array(z.enum(['UPDATE_PROFILE', 'RESOLVE_CATALOG_ITEMS', 'CLARIFY_ITEM', 'PROPOSE_ORDER'])).max(4).default([]),
  confidence: z.coerce.number().min(0).max(1),
  uncertainty: z.string().trim().max(300).nullable().optional(),
});

export type CommerceTurnInterpretation = z.infer<typeof interpretationSchema>;

/** Validate model output before it can influence catalogue lookup or state. */
export function validateCommerceInterpretation(value: unknown): CommerceTurnInterpretation | null {
  const parsed = interpretationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Semantic turn interpretation. The model identifies roles and entities; it
 * cannot select a database id, price an item, or execute an order. Those stay
 * with the authoritative catalogue and persisted sales-flow state.
 */
export async function interpretCommerceTurn(input: {
  provider: AiProvider;
  message: string;
  recentConversation: string;
  knownCustomerName?: string;
  catalogueNames: string[];
  stateSummary?: string;
}): Promise<CommerceTurnInterpretation | null> {
  const raw = await input.provider.complete([
    {
      role: 'system',
      content:
        'Interpret the latest customer turn for a commerce workflow. Separate profile information ' +
        '(such as a person introducing themselves) from products they want. Resolve pronouns only ' +
        'when the supplied conversation/state supports them. Return requested product phrases in ' +
        'the customer’s words with quantities. The phrase field must contain only the product phrase: ' +
        'put leading quantities and units such as “5 plates of” exclusively in quantity/unit, never in phrase. ' +
        'Do not invent catalogue ids, prices, stock, names, ' +
        'or actions. A purchase must be proposed for confirmation, never executed here. Choose the ' +
        'smallest useful action plan. Return JSON only: ' +
        '{"profile"?: {"name"?: string}, "items": [{"phrase": string, "quantity": integer, "unit"?: string}], ' +
        '"actions": ["UPDATE_PROFILE"|"RESOLVE_CATALOG_ITEMS"|"CLARIFY_ITEM"|"PROPOSE_ORDER"], ' +
        '"confidence": number, "uncertainty"?: string|null}.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        knownCustomerName: input.knownCustomerName || null,
        latestMessage: input.message,
        currentSalesState: input.stateSummary || null,
        recentConversation: input.recentConversation.slice(-5000),
        customerFacingCatalogueNames: input.catalogueNames.slice(0, 100),
      }),
    },
  ], {
    maxTokens: 350,
    temperature: 0.1,
    jsonMode: true,
    dataSources: ['user_provided', 'vhicasar_business'],
  });
  return validateCommerceInterpretation(extractJson<unknown>(raw));
}
