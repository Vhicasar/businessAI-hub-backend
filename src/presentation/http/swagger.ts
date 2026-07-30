import { env } from '../../shared/config/env';

const sessionSchema = {
  type: 'object',
  properties: {
    accessToken: { type: 'string' },
    refreshToken: { type: 'string', description: 'Also set as httpOnly cookie for web clients' },
    user: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        email: { type: 'string' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        emailVerified: { type: 'boolean' },
        twoFactorEnabled: { type: 'boolean' },
      },
    },
    organization: {
      type: 'object',
      nullable: true,
      properties: { id: { type: 'string' }, name: { type: 'string' }, slug: { type: 'string' } },
    },
  },
} as const;

const ok = (dataSchema: unknown) => ({
  type: 'object',
  properties: { success: { type: 'boolean', example: true }, data: dataSchema },
});

const errorResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean', example: false },
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: { type: 'object', nullable: true },
      },
    },
  },
} as const;

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Vhicasar Hub AI API',
    version: '1.0.0',
    description:
      'Omnichannel AI CRM — REST API v1. All responses use the `{ success, data }` / `{ success: false, error }` envelope.',
  },
  servers: [{ url: `${env.API_BASE_URL}/api` }],
  tags: [
    { name: 'Auth', description: 'Authentication, sessions, 2FA' },
    { name: 'Health', description: 'Liveness and readiness' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: { Session: sessionSchema, Error: errorResponse },
  },
  paths: {
    '/v1/health': {
      get: { tags: ['Health'], summary: 'Liveness probe', responses: { 200: { description: 'OK' } } },
    },
    '/v1/health/ready': {
      get: {
        tags: ['Health'],
        summary: 'Readiness probe (checks database)',
        responses: { 200: { description: 'Ready' }, 503: { description: 'Not ready' } },
      },
    },
    '/v1/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Register a business workspace',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['organizationName', 'firstName', 'lastName', 'email', 'password'],
                properties: {
                  organizationName: { type: 'string' },
                  businessType: { type: 'string', example: 'ECOMMERCE' },
                  firstName: { type: 'string' },
                  lastName: { type: 'string' },
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', minLength: 10 },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Workspace created', content: { 'application/json': { schema: ok(sessionSchema) } } },
          409: { description: 'Email already registered' },
        },
      },
    },
    '/v1/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Login (returns session, or MFA challenge when 2FA enabled)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Session or `{ mfaRequired: true, mfaToken }`' },
          401: { description: 'Invalid credentials / locked / suspended' },
        },
      },
    },
    '/v1/auth/2fa/verify': {
      post: {
        tags: ['Auth'],
        summary: 'Complete login with TOTP or backup code',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['mfaToken', 'code'],
                properties: { mfaToken: { type: 'string' }, code: { type: 'string' } },
              },
            },
          },
        },
        responses: { 200: { description: 'Session' }, 401: { description: 'Invalid code' } },
      },
    },
    '/v1/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Rotate refresh token (cookie or body) for a new session',
        responses: { 200: { description: 'New session' }, 401: { description: 'Invalid/reused/expired' } },
      },
    },
    '/v1/auth/logout': {
      post: { tags: ['Auth'], summary: 'Logout current session family', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Logged out' } } },
    },
    '/v1/auth/logout-all': {
      post: { tags: ['Auth'], summary: 'Revoke all sessions', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Revoked' } } },
    },
    '/v1/auth/forgot-password': {
      post: { tags: ['Auth'], summary: 'Request password reset email', responses: { 200: { description: 'Always OK (no enumeration)' } } },
    },
    '/v1/auth/reset-password': {
      post: { tags: ['Auth'], summary: 'Set new password with reset token', responses: { 200: { description: 'Updated' }, 400: { description: 'Invalid token' } } },
    },
    '/v1/auth/verify-email': {
      post: { tags: ['Auth'], summary: 'Verify email with token', responses: { 200: { description: 'Verified' } } },
    },
    '/v1/auth/2fa/setup': {
      post: { tags: ['Auth'], summary: 'Generate TOTP secret + otpauth URL', security: [{ bearerAuth: [] }], responses: { 200: { description: '`{ secret, otpauthUrl }`' } } },
    },
    '/v1/auth/2fa/enable': {
      post: { tags: ['Auth'], summary: 'Confirm TOTP and enable 2FA (returns backup codes)', security: [{ bearerAuth: [] }], responses: { 200: { description: '`{ backupCodes: [...] }`' } } },
    },
    '/v1/auth/2fa/disable': {
      post: { tags: ['Auth'], summary: 'Disable 2FA (password + code required)', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Disabled' } } },
    },
    '/v1/auth/me': {
      get: { tags: ['Auth'], summary: 'Current user with memberships, role and permission keys', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Profile' } } },
    },
    '/v1/auth/sessions': {
      get: { tags: ['Auth'], summary: 'Active sessions (device list)', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Sessions' } } },
    },
    '/v1/auth/sessions/{id}': {
      delete: {
        tags: ['Auth'],
        summary: 'Revoke one session',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Revoked' } },
      },
    },
    '/v1/auth/switch-org': {
      post: { tags: ['Auth'], summary: 'Re-issue session for another organization membership', security: [{ bearerAuth: [] }], responses: { 200: { description: 'New session' } } },
    },
  },
} as const;
