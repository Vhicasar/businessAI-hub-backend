import { Prisma } from '@prisma/client';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { encrypt } from '../../shared/crypto';
import { requestContext } from '../../shared/context';
import { ValidationError } from '../../shared/errors';
import { deliveryServiceByProvider } from './delivery-config-sync';
import { quoteFromCarrier } from './carrier-rates.service';

/**
 * A business's own account with a delivery service.
 *
 * Kept in `IntegrationCredential`, which is already tenant-scoped and already
 * the place every other bring-your-own credential lives — so isolation between
 * businesses is the database's job rather than something this file has to
 * remember to do. The provider key is namespaced so a courier account cannot
 * collide with a payment or messaging one.
 *
 * The secret goes in encrypted and never comes back out to a browser. A
 * business that needs to change it types a new one; one that does not, never
 * sees it.
 */

const key = (provider: string): string => `delivery:${provider}`;

const orgId = (): string => {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
};

export interface CarrierConnection {
  provider: string;
  connected: boolean;
  isActive: boolean;
  /** Presence, never the value. */
  hasApiKey: boolean;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  updatedAt: string | null;
}

export async function carrierConnection(provider: string): Promise<CarrierConnection> {
  const row = await prisma.integrationCredential.findFirst({
    where: { provider: key(provider) },
  });
  const metadata = ((row?.metadata as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  return {
    provider,
    connected: Boolean(row),
    isActive: row?.isActive ?? false,
    hasApiKey: Boolean(row?.credentialsEnc),
    lastTestedAt: (metadata.lastTestedAt as string) ?? null,
    lastTestOk: (metadata.lastTestOk as boolean) ?? null,
    lastTestError: (metadata.lastTestError as string) ?? null,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  };
}

export async function connectCarrier(input: {
  provider: string;
  apiKey: string;
  options?: Record<string, unknown>;
}): Promise<CarrierConnection> {
  const service = deliveryServiceByProvider(input.provider);
  if (!service) {
    throw new ValidationError('That delivery service is not available on this platform.');
  }
  if (!service.allowBusinessCredentials) {
    // The platform decides whether businesses may bring their own account.
    // Saving one anyway would create a credential nothing is allowed to use.
    throw new ValidationError(
      `${service.label ?? input.provider} does not accept a business’s own account on this platform.`,
    );
  }
  if (!input.apiKey.trim()) throw new ValidationError('Enter the credential for this service.');

  const organizationId = orgId();
  const existing = await prisma.integrationCredential.findFirst({ where: { provider: key(input.provider) } });
  const metadata = {
    ...((existing?.metadata as Record<string, unknown>) ?? {}),
    options: input.options ?? {},
  } as Prisma.InputJsonValue;

  if (existing) {
    await prisma.integrationCredential.update({
      where: { id: existing.id },
      data: { credentialsEnc: encrypt(input.apiKey.trim()), isActive: true, metadata },
    });
  } else {
    await prismaUnscoped.integrationCredential.create({
      data: {
        organizationId,
        provider: key(input.provider),
        credentialsEnc: encrypt(input.apiKey.trim()),
        isActive: true,
        metadata,
      },
    });
  }
  return carrierConnection(input.provider);
}

export async function disconnectCarrier(provider: string): Promise<{ provider: string; disconnected: boolean }> {
  const existing = await prisma.integrationCredential.findFirst({ where: { provider: key(provider) } });
  if (!existing) return { provider, disconnected: false };
  await prisma.integrationCredential.delete({ where: { id: existing.id } });
  return { provider, disconnected: true };
}

/** The stored secret, for the pricing service only. Never returned to a client. */
export async function carrierCredentialFor(
  organizationId: string,
  provider: string,
): Promise<{ apiKeyEnc: string | null; options: Record<string, unknown> }> {
  const row = await prismaUnscoped.integrationCredential.findFirst({
    where: { organizationId, provider: key(provider), isActive: true },
    select: { credentialsEnc: true, metadata: true },
  });
  const metadata = (row?.metadata as Record<string, unknown>) ?? {};
  return {
    apiKeyEnc: row?.credentialsEnc ?? null,
    options: (metadata.options as Record<string, unknown>) ?? {},
  };
}

/**
 * Prove the business's own account works, by asking for a real quote.
 *
 * A saved credential is not a working one, and the only way to know is to use
 * it. The quote is thrown away — this is a connectivity test, not a price.
 */
export async function testCarrierConnection(provider: string): Promise<CarrierConnection> {
  const service = deliveryServiceByProvider(provider);
  if (!service) throw new ValidationError('That delivery service is not available on this platform.');

  const organizationId = orgId();
  const credential = await carrierCredentialFor(organizationId, provider);
  const org = await prismaUnscoped.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { currency: true, city: true, country: true },
  });

  const blank = { line1: '', line2: '', city: org.city ?? '', state: '', country: org.country ?? '', postalCode: '' };
  const quote = await quoteFromCarrier({
    service,
    businessApiKeyEnc: credential.apiKeyEnc,
    businessOptions: credential.options,
    origin: { address: blank, latitude: null, longitude: null },
    destination: { address: blank, latitude: null, longitude: null },
    weightGrams: 1000,
    subtotal: 0,
    currency: org.currency,
  });

  const existing = await prisma.integrationCredential.findFirst({ where: { provider: key(provider) } });
  if (existing) {
    await prisma.integrationCredential.update({
      where: { id: existing.id },
      data: {
        metadata: {
          ...((existing.metadata as Record<string, unknown>) ?? {}),
          lastTestedAt: new Date().toISOString(),
          lastTestOk: quote.ok,
          lastTestError: quote.ok ? null : quote.error,
        } as Prisma.InputJsonValue,
      },
    });
  }
  return carrierConnection(provider);
}
