import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/authenticate';
import { authLimiter, forgotPasswordLimiter } from '../middleware/rate-limit';
import { authController as c } from './auth.controller';
import {
  createOrganizationSchema,
  forgotPasswordSchema,
  loginSchema,
  switchOrganizationSchema,
  mfaVerifySchema,
  registerSchema,
  resetPasswordSchema,
  twoFaDisableSchema,
  twoFaEnableSchema,
  verifyEmailSchema,
  resendVerificationSchema,
} from '../../../application/auth/auth.dto';
import { CURRENCIES, resolveLocale } from '../../../shared/currency';

export const authRoutes = Router();

/**
 * Public. What currency should this visitor's workspace use, and what else can
 * they pick? Served from the backend so the timezone→currency map has exactly
 * one definition; the signup form passes the browser's own hints.
 */
authRoutes.get('/locale', (req, res) => {
  const resolved = resolveLocale({
    timezone: typeof req.query.timezone === 'string' ? req.query.timezone : null,
    locale: typeof req.query.locale === 'string' ? req.query.locale : null,
  });
  res.json({
    success: true,
    data: {
      ...resolved,
      currencies: CURRENCIES.map((x) => ({ code: x.code, name: x.name, symbol: x.symbol })),
    },
  });
});

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
authRoutes.post(
  '/resend-verification',
  forgotPasswordLimiter,
  validate({ body: resendVerificationSchema }),
  c.resendVerification,
);

// Authenticated
authRoutes.post('/logout', authenticate, c.logout);
authRoutes.post('/logout-all', authenticate, c.logoutAll);
authRoutes.get('/me', authenticate, c.me);

// A user can run several businesses. The active one is a claim inside the
// access token, so switching mints a new session rather than flipping a flag.
authRoutes.get('/organizations', authenticate, c.organizations);
authRoutes.post(
  '/organizations/switch',
  authenticate,
  validate({ body: switchOrganizationSchema }),
  c.switchOrganization,
);
authRoutes.post(
  '/organizations',
  authenticate,
  validate({ body: createOrganizationSchema }),
  c.createOrganization,
);
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
