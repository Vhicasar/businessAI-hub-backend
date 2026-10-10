import { Prisma } from '@prisma/client';

export type ManufacturingDocumentKind = 'PO' | 'MR' | 'MI' | 'RT' | 'BT' | 'FGR';

/**
 * One concurrency-safe human reference generator for manufacturing documents.
 * UUIDs remain the identity; these values are display/search references only.
 * A business can set `documentPrefix` in Organization.settings. Existing
 * references are never rewritten when the setting or business name changes.
 */
export async function nextManufacturingDocumentNumber(tx: any, organizationId: string, kind: ManufacturingDocumentKind) {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`${organizationId}:document:${kind}`}))`);
  const organization = await tx.organization.findUnique({ where: { id: organizationId }, select: { name: true, settings: true } });
  const settings = (organization?.settings && typeof organization.settings === 'object') ? organization.settings as Record<string, unknown> : {};
  const configured = typeof settings.documentPrefix === 'string' ? settings.documentPrefix : '';
  const generated = (organization?.name ?? 'Vhicasar').split(/\s+/).map((part: string) => part[0]).join('').slice(0, 5);
  const prefix = (configured || generated || 'VHI').replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 6) || 'VHI';
  const year = new Date().getUTCFullYear();
  const marker = `${prefix}-${kind}-${year}-`;
  const count = kind === 'MR'
    ? await tx.productionMaterialRequisition.count({ where: { organizationId, number: { startsWith: marker } } })
    : kind === 'MI'
      ? await tx.productionMaterialIssue.count({ where: { organizationId, number: { startsWith: marker } } })
      : kind === 'RT'
        ? await tx.productionMaterialReturn.count({ where: { organizationId, number: { startsWith: marker } } })
      : kind === 'FGR'
        ? (await tx.finishedGoodsReceipt.count({ where: { organizationId, number: { startsWith: marker } } })) +
          (await tx.finishedGoodsReceiptTask.count({ where: { organizationId, number: { startsWith: marker } } }))
        : 0;
  return `${marker}${String(count + 1).padStart(4, '0')}`;
}
