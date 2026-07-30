import { z } from 'zod';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { ConflictError, NotFoundError } from '../../shared/errors';

const domain = z.string().trim().toLowerCase()
  .transform((value) => value.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
  .refine((value) => /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value), 'Invalid domain');

export const domainConfigSchema = z.object({
  name: z.string().trim().min(2).max(80),
  provider: z.enum(['HOSTINGER', 'CLOUDFLARE', 'AWS_ROUTE53', 'CUSTOM']).default('HOSTINGER'),
  baseDomain: domain,
  cnameTarget: domain,
  verificationTarget: z.string().trim().max(255).nullable().optional(),
});

export const domainConfigService = {
  list() {
    return prismaUnscoped.domainDeploymentConfig.findMany({ orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }] });
  },

  async active() {
    return prismaUnscoped.domainDeploymentConfig.findFirst({ where: { isActive: true } })
      ?? prismaUnscoped.domainDeploymentConfig.findFirst({ where: { isDefault: true } });
  },

  async create(dto: z.infer<typeof domainConfigSchema>) {
    const exists = await prismaUnscoped.domainDeploymentConfig.findUnique({ where: { baseDomain: dto.baseDomain } });
    if (exists) throw new ConflictError('A deployment configuration already uses this domain');
    return prismaUnscoped.domainDeploymentConfig.create({ data: dto });
  },

  async update(id: string, dto: Partial<z.infer<typeof domainConfigSchema>>) {
    const exists = await prismaUnscoped.domainDeploymentConfig.findUnique({ where: { id } });
    if (!exists) throw new NotFoundError('Domain deployment configuration');
    return prismaUnscoped.domainDeploymentConfig.update({ where: { id }, data: dto });
  },

  async activate(id: string) {
    const exists = await prismaUnscoped.domainDeploymentConfig.findUnique({ where: { id } });
    if (!exists) throw new NotFoundError('Domain deployment configuration');
    await prismaUnscoped.$transaction([
      prismaUnscoped.domainDeploymentConfig.updateMany({ data: { isActive: false } }),
      prismaUnscoped.domainDeploymentConfig.update({ where: { id }, data: { isActive: true } }),
    ]);
    return prismaUnscoped.domainDeploymentConfig.findUnique({ where: { id } });
  },

  async remove(id: string) {
    const config = await prismaUnscoped.domainDeploymentConfig.findUnique({ where: { id } });
    if (!config) throw new NotFoundError('Domain deployment configuration');
    if (config.isDefault) throw new ConflictError('The default Hostinger configuration cannot be deleted');
    if (config.isActive) throw new ConflictError('Switch to another configuration before deleting this one');
    await prismaUnscoped.domainDeploymentConfig.delete({ where: { id } });
    return { deleted: true };
  },
};
