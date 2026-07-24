import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import { env } from '../../../shared/config/env';
import { UnauthorizedError } from '../../../shared/errors';
import { authService, type RequestMeta } from '../../../application/auth/auth.service';

const REFRESH_COOKIE = 'bh_refresh';

const cookieOpts: CookieOptions = {
  httpOnly: true,
  secure: env.isProd,
  sameSite: 'strict',
  path: '/api/v1/auth',
  maxAge: env.jwt.refreshTtlDays * 24 * 60 * 60 * 1000,
};

function meta(req: Request): RequestMeta {
  return { userAgent: req.headers['user-agent'], ipAddress: req.ip };
}

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, cookieOpts);
}

function readRefreshToken(req: Request): string | undefined {
  // Web clients use the httpOnly cookie; Flutter clients send it in the body.
  return (req.cookies?.[REFRESH_COOKIE] as string | undefined) ?? req.body?.refreshToken;
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const authController = {
  register: wrap(async (req, res) => {
    const result = await authService.register(req.body, meta(req));
    res.status(201).json({ success: true, data: result });
  }),

  login: wrap(async (req, res) => {
    const result = await authService.login(req.body, meta(req));
    if ('mfaRequired' in result) {
      res.json({ success: true, data: result });
      return;
    }
    setRefreshCookie(res, result.refreshToken);
    res.json({ success: true, data: result });
  }),

  verifyMfa: wrap(async (req, res) => {
    const session = await authService.verifyMfa(req.body, meta(req));
    setRefreshCookie(res, session.refreshToken);
    res.json({ success: true, data: session });
  }),

  refresh: wrap(async (req, res) => {
    const raw = readRefreshToken(req);
    if (!raw) throw new UnauthorizedError('Refresh token missing', 'REFRESH_MISSING');
    const session = await authService.refresh(raw, meta(req));
    setRefreshCookie(res, session.refreshToken);
    res.json({ success: true, data: session });
  }),

  logout: wrap(async (req, res) => {
    const raw = readRefreshToken(req);
    if (req.auth) await authService.logout(raw, req.auth.userId, meta(req));
    res.clearCookie(REFRESH_COOKIE, { ...cookieOpts, maxAge: undefined });
    res.json({ success: true, data: { message: 'Logged out' } });
  }),

  logoutAll: wrap(async (req, res) => {
    await authService.logoutAll(req.auth!.userId, meta(req));
    res.clearCookie(REFRESH_COOKIE, { ...cookieOpts, maxAge: undefined });
    res.json({ success: true, data: { message: 'All sessions revoked' } });
  }),

  forgotPassword: wrap(async (req, res) => {
    await authService.forgotPassword(req.body.email);
    res.json({
      success: true,
      data: { message: 'If that email exists, a reset link has been sent' },
    });
  }),

  resetPassword: wrap(async (req, res) => {
    await authService.resetPassword(req.body.token, req.body.password, meta(req));
    res.json({ success: true, data: { message: 'Password updated. Please sign in.' } });
  }),

  verifyEmail: wrap(async (req, res) => {
    await authService.verifyEmail(req.body.token);
    res.json({ success: true, data: { message: 'Email verified' } });
  }),

  resendVerification: wrap(async (req, res) => {
    await authService.resendEmailVerification(req.body.email);
    res.json({
      success: true,
      data: { message: 'If that unverified account exists, a new verification link has been sent.' },
    });
  }),

  twoFaSetup: wrap(async (req, res) => {
    const result = await authService.setupTwoFactor(req.auth!.userId);
    res.json({ success: true, data: result });
  }),

  twoFaEnable: wrap(async (req, res) => {
    const result = await authService.enableTwoFactor(req.auth!.userId, req.body.code, meta(req));
    res.json({ success: true, data: result });
  }),

  twoFaDisable: wrap(async (req, res) => {
    await authService.disableTwoFactor(req.auth!.userId, req.body.password, req.body.code, meta(req));
    res.json({ success: true, data: { message: 'Two-factor disabled' } });
  }),

  me: wrap(async (req, res) => {
    const data = await authService.me(req.auth!.userId);
    res.json({ success: true, data });
  }),

  // ------------------------------------------------- multiple businesses
  organizations: wrap(async (req, res) => {
    const data = await authService.organizations(req.auth!.userId);
    res.json({ success: true, data });
  }),

  switchOrganization: wrap(async (req, res) => {
    const session = await authService.switchOrganization(
      req.auth!.userId,
      req.body.organizationId,
      meta(req),
    );
    // A switch mints a new session, so the refresh cookie has to follow it.
    setRefreshCookie(res, session.refreshToken);
    res.json({ success: true, data: session });
  }),

  createOrganization: wrap(async (req, res) => {
    const session = await authService.createOrganization(req.auth!.userId, req.body, meta(req));
    setRefreshCookie(res, session.refreshToken);
    res.status(201).json({ success: true, data: session });
  }),

  sessions: wrap(async (req, res) => {
    const data = await authService.listSessions(req.auth!.userId);
    res.json({ success: true, data });
  }),

  revokeSession: wrap(async (req, res) => {
    await authService.revokeSession(req.auth!.userId, req.params.id as string);
    res.json({ success: true, data: { message: 'Session revoked' } });
  }),

  switchOrg: wrap(async (req, res) => {
    const session = await authService.switchOrganization(
      req.auth!.userId,
      req.body.organizationId,
      meta(req)
    );
    setRefreshCookie(res, session.refreshToken);
    res.json({ success: true, data: session });
  }),
};
