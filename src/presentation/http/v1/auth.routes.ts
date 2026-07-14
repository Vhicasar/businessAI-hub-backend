import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/authenticate';
import { authLimiter, forgotPasswordLimiter } from '../middleware/rate-limit';
import { authController as c } from './auth.controller';
import {
  forgotPasswordSchema,
  loginSchema,
  mfaVerifySchema,
  registerSchema,
  resetPasswordSchema,
  twoFaDisableSchema,
  twoFaEnableSchema,
  verifyEmailSchema,
} from '../../../application/auth/auth.dto';

export const authRoutes = Router();

// Public
authRoutes.post('/register', authLimiter, validate({ body: registerSchema }), c.register);
authRoutes.post('/login', authLimiter, validate({ body: loginSchema }), c.login);
authRoutes.post('/2fa/verify', authLimiter, validate({ body: mfaVerifySchema }), c.verifyMfa);
authRoutes.post('/refresh', c.refresh);
authRoutes.post(
  '/forgot-password',
  forgotPasswordLimiter,
  validate({ body: forgotPasswordSchema }),
  c.forgotPassword
);
authRoutes.post('/reset-password', authLimiter, validate({ body: resetPasswordSchema }), c.resetPassword);
authRoutes.post('/verify-email', validate({ body: verifyEmailSchema }), c.verifyEmail);

// Authenticated
authRoutes.post('/logout', authenticate, c.logout);
authRoutes.post('/logout-all', authenticate, c.logoutAll);
authRoutes.get('/me', authenticate, c.me);
authRoutes.get('/sessions', authenticate, c.sessions);
authRoutes.delete('/sessions/:id', authenticate, c.revokeSession);
authRoutes.post('/2fa/setup', authenticate, c.twoFaSetup);
authRoutes.post('/2fa/enable', authenticate, validate({ body: twoFaEnableSchema }), c.twoFaEnable);
authRoutes.post('/2fa/disable', authenticate, validate({ body: twoFaDisableSchema }), c.twoFaDisable);
authRoutes.post(
  '/switch-org',
  authenticate,
  validate({ body: z.object({ organizationId: z.string().min(1) }) }),
  c.switchOrg
);
