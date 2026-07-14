import { Router } from 'express';
import { prismaUnscoped } from '../../../infrastructure/database/prisma';

export const healthRoutes = Router();

/** Liveness — process is up. */
healthRoutes.get('/', (_req, res) => {
  res.json({ success: true, data: { status: 'ok', uptime: process.uptime() } });
});

/** Readiness — dependencies reachable. */
healthRoutes.get('/ready', async (_req, res) => {
  try {
    await prismaUnscoped.$queryRaw`SELECT 1`;
    res.json({ success: true, data: { status: 'ready', database: 'up' } });
  } catch {
    res.status(503).json({
      success: false,
      error: { code: 'NOT_READY', message: 'Database unreachable' },
    });
  }
});
