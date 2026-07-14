import rateLimit from 'express-rate-limit';

const standardResponse = {
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' },
  },
};

/** Global API limiter. */
export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  ...standardResponse,
});

/** Strict limiter for credential endpoints (per IP). */
export const authLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  skipSuccessfulRequests: true,
  ...standardResponse,
});

/** Password-reset request limiter. */
export const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 3,
  ...standardResponse,
});
