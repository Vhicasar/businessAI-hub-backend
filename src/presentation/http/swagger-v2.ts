/**
 * OpenAPI paths for the v2.0 platform surfaces: Vhicasar ID, Vhicasar Pay,
 * the Customer Super App API, POS and platform monitoring (API Bible §15 —
 * every endpoint documents its auth, permissions, schemas and errors).
 *
 * Kept separate from swagger.ts so the original auth/health document stays
 * readable; both are merged in `openApiDocument`.
 */

const ok = (dataSchema: unknown) => ({
  type: 'object',
  properties: { success: { type: 'boolean', example: true }, data: dataSchema },
});

const jsonResponse = (description: string, schema: unknown) => ({
  description,
  content: { 'application/json': { schema } },
});

const errorRef = { $ref: '#/components/schemas/Error' };

const money = { type: 'string', example: '1500.00', description: 'Fixed-2 decimal string' };

/** Reusable error responses so each path documents its real failure modes. */
const commonErrors = {
  400: jsonResponse('Validation error', errorRef),
  401: jsonResponse('Authentication required', errorRef),
  403: jsonResponse('Authorization denied', errorRef),
  404: jsonResponse('Not found', errorRef),
};

const bodyOf = (schema: unknown, required = true) => ({
  required,
  content: { 'application/json': { schema } },
});

// ---- Shared schemas ----

export const v2Schemas = {
  Identity: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      publicId: { type: 'string', example: 'VH-7QK2-9F3P' },
      phone: { type: 'string', example: '+2348030000000' },
      email: { type: 'string', nullable: true },
      displayName: { type: 'string', nullable: true },
      status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'CLOSED'] },
      kycLevel: { type: 'string', enum: ['NONE', 'BASIC', 'VERIFIED'] },
      hasPin: { type: 'boolean' },
    },
  },
  AppSession: {
    type: 'object',
    properties: {
      accessToken: { type: 'string' },
      refreshToken: { type: 'string', description: 'Opaque, rotated on every use' },
      expiresIn: { type: 'string', example: '15m' },
      identity: { $ref: '#/components/schemas/Identity' },
    },
  },
  Wallet: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      balance: money,
      currency: { type: 'string', example: 'NGN' },
      status: { type: 'string', enum: ['ACTIVE', 'FROZEN', 'CLOSED'] },
    },
  },
  PaymentSession: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      sessionToken: { type: 'string', description: 'Encoded in the dynamic QR' },
      amount: money,
      currency: { type: 'string' },
      status: { type: 'string', enum: ['CREATED', 'AUTHORIZED', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED'] },
      expiresAt: { type: 'string', format: 'date-time' },
      qrPayload: { type: 'string', description: 'What the merchant renders as a QR code' },
    },
  },
  Payout: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      amount: money,
      currency: { type: 'string' },
      status: { type: 'string', enum: ['PENDING', 'PROCESSING', 'PAID', 'FAILED', 'REVERSED'] },
      accountNumberMasked: { type: 'string', example: '••••1234' },
      requestedAt: { type: 'string', format: 'date-time' },
    },
  },
} as const;

// ---- Customer Super App (/api/app/v1) ----

const appPaths = {
  '/app/v1/auth/register': {
    post: {
      tags: ['Super App — Identity'],
      summary: 'Create a Vhicasar ID',
      description: 'Registers a global consumer identity. Public — no token required.',
      security: [],
      requestBody: bodyOf({
        type: 'object',
        required: ['phone', 'firstName', 'password'],
        properties: {
          phone: { type: 'string', example: '+2348030000000' },
          firstName: { type: 'string' },
          lastName: { type: 'string' },
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 8 },
        },
      }),
      responses: {
        201: jsonResponse('Account created', ok({ $ref: '#/components/schemas/AppSession' })),
        409: jsonResponse('Phone or email already registered', errorRef),
        ...commonErrors,
      },
    },
  },
  '/app/v1/auth/login': {
    post: {
      tags: ['Super App — Identity'],
      summary: 'Sign in with phone + password',
      security: [],
      requestBody: bodyOf({
        type: 'object',
        required: ['phone', 'password'],
        properties: { phone: { type: 'string' }, password: { type: 'string' } },
      }),
      responses: {
        200: jsonResponse('Signed in', ok({ $ref: '#/components/schemas/AppSession' })),
        ...commonErrors,
      },
    },
  },
  '/app/v1/auth/refresh': {
    post: {
      tags: ['Super App — Identity'],
      summary: 'Rotate the session',
      description:
        'Exchanges a refresh token for a new access + refresh pair. Presenting an already-rotated token revokes the whole family (replay protection).',
      security: [],
      requestBody: bodyOf({
        type: 'object',
        required: ['refreshToken'],
        properties: { refreshToken: { type: 'string' } },
      }),
      responses: {
        200: jsonResponse('Rotated', ok({ $ref: '#/components/schemas/AppSession' })),
        401: jsonResponse('REFRESH_INVALID | REFRESH_EXPIRED | REFRESH_REUSED', errorRef),
      },
    },
  },
  '/app/v1/auth/logout': {
    post: {
      tags: ['Super App — Identity'],
      summary: 'Revoke the session family',
      description: 'Idempotent — an unknown token still returns success.',
      security: [],
      requestBody: bodyOf({ type: 'object', properties: { refreshToken: { type: 'string' } } }),
      responses: { 200: jsonResponse('Signed out', ok({ type: 'object' })) },
    },
  },
  '/app/v1/identity/me': {
    get: {
      tags: ['Super App — Identity'],
      summary: 'Current Vhicasar ID profile',
      responses: { 200: jsonResponse('Profile', ok({ $ref: '#/components/schemas/Identity' })), ...commonErrors },
    },
  },
  '/app/v1/identity/pin': {
    put: {
      tags: ['Super App — Identity'],
      summary: 'Set the transaction PIN',
      description: 'The PIN gates every payment, transfer and withdrawal.',
      requestBody: bodyOf({
        type: 'object',
        required: ['pin'],
        properties: { pin: { type: 'string', pattern: '^\\d{4,6}$' } },
      }),
      responses: { 200: jsonResponse('Updated', ok({ type: 'object' })), ...commonErrors },
    },
  },
  '/app/v1/identity/businesses': {
    get: {
      tags: ['Super App — Identity'],
      summary: 'Businesses this identity is linked to',
      description: 'The universal profile: every participating business the consumer has a relationship with.',
      responses: { 200: jsonResponse('Linked businesses', ok({ type: 'array', items: { type: 'object' } })), ...commonErrors },
    },
  },
  '/app/v1/devices': {
    post: {
      tags: ['Super App — Identity'],
      summary: 'Register a device',
      description:
        'Registers the device and its public key. A device with a key MUST sign payment confirmations. Returns a device-bound session.',
      requestBody: bodyOf({
        type: 'object',
        required: ['deviceId', 'platform'],
        properties: {
          deviceId: { type: 'string' },
          platform: { type: 'string', enum: ['android', 'ios', 'web'] },
          publicKey: { type: 'string', description: 'Base64 SPKI (Ed25519 or ECDSA P-256)' },
          pushToken: { type: 'string' },
          isBiometricEnabled: { type: 'boolean' },
        },
      }),
      responses: { 201: jsonResponse('Registered', ok({ type: 'object' })), ...commonErrors },
    },
    get: {
      tags: ['Super App — Identity'],
      summary: 'List registered devices',
      responses: { 200: jsonResponse('Devices', ok({ type: 'array', items: { type: 'object' } })), ...commonErrors },
    },
  },
  '/app/v1/wallet': {
    get: {
      tags: ['Super App — Wallet'],
      summary: 'Wallet balance',
      responses: { 200: jsonResponse('Wallet', ok({ $ref: '#/components/schemas/Wallet' })), ...commonErrors },
    },
  },
  '/app/v1/wallet/topup': {
    post: {
      tags: ['Super App — Wallet'],
      summary: 'Start a wallet top-up',
      description:
        'Creates a real gateway checkout and returns its authorization URL. The wallet is credited only after the gateway confirms the charge (callback or webhook), so the credit is idempotent per reference.',
      parameters: [
        {
          name: 'Idempotency-Key',
          in: 'header',
          schema: { type: 'string' },
          description: 'Required for safe retries (API Bible §10).',
        },
      ],
      requestBody: bodyOf({
        type: 'object',
        required: ['amount', 'currency'],
        properties: { amount: { type: 'number' }, currency: { type: 'string', example: 'NGN' } },
      }),
      responses: { 201: jsonResponse('Checkout created', ok({ type: 'object' })), ...commonErrors },
    },
  },
  '/app/v1/wallet/transfer': {
    post: {
      tags: ['Super App — Wallet'],
      summary: 'Send money to another Vhicasar ID',
      description: 'PIN-gated. Debits and credits post atomically in the double-entry ledger.',
      requestBody: bodyOf({
        type: 'object',
        required: ['recipient', 'amount', 'currency', 'pin'],
        properties: {
          recipient: { type: 'string', description: 'Vhicasar public id or phone' },
          amount: { type: 'number' },
          currency: { type: 'string' },
          pin: { type: 'string' },
        },
      }),
      responses: {
        201: jsonResponse('Transferred', ok({ type: 'object' })),
        409: jsonResponse('INSUFFICIENT_FUNDS', errorRef),
        ...commonErrors,
      },
    },
  },
  '/app/v1/payments/session/{token}': {
    get: {
      tags: ['Super App — Pay'],
      summary: 'Scan a dynamic QR',
      description: 'Read-only view of the pending charge. Expired sessions are reported as EXPIRED.',
      parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: jsonResponse('Session', ok({ $ref: '#/components/schemas/PaymentSession' })), ...commonErrors },
    },
  },
  '/app/v1/payments/nonce': {
    post: {
      tags: ['Super App — Pay'],
      summary: 'Request a signing challenge',
      description:
        'Single-use, 5-minute nonce. The device signs `sessionToken.nonce.amount.currency` and sends the signature to /payments/confirm.',
      requestBody: bodyOf({
        type: 'object',
        required: ['deviceId'],
        properties: { deviceId: { type: 'string' }, sessionId: { type: 'string' } },
      }),
      responses: { 201: jsonResponse('Challenge', ok({ type: 'object' })), ...commonErrors },
    },
  },
  '/app/v1/payments/confirm': {
    post: {
      tags: ['Super App — Pay'],
      summary: 'Confirm and pay a session',
      description:
        'Moves the money. PIN is always required; a device with a registered key must also supply a nonce + signature. Idempotent per session — a repeat confirm can never double-charge.',
      parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }],
      requestBody: bodyOf({
        type: 'object',
        required: ['sessionToken', 'pin'],
        properties: {
          sessionToken: { type: 'string' },
          pin: { type: 'string' },
          deviceId: { type: 'string' },
          nonce: { type: 'string' },
          signature: { type: 'string', description: 'Base64 device signature' },
        },
      }),
      responses: {
        ...commonErrors,
        200: jsonResponse('Paid', ok({ type: 'object' })),
        403: jsonResponse('FRAUD_DETECTED | DEVICE_SIGNATURE_REQUIRED | NONCE_INVALID', errorRef),
        409: jsonResponse('PAYMENT_SESSION_EXPIRED | SESSION_NOT_PAYABLE', errorRef),
      },
    },
  },
  '/app/v1/payouts/accounts': {
    get: {
      tags: ['Super App — Payouts'],
      summary: 'List bank accounts',
      responses: { 200: jsonResponse('Accounts', ok({ type: 'array', items: { type: 'object' } })), ...commonErrors },
    },
    post: {
      tags: ['Super App — Payouts'],
      summary: 'Add a bank account',
      description: 'The account number is verified with the bank and stored encrypted; only the last 4 digits are returned.',
      requestBody: bodyOf({
        type: 'object',
        required: ['accountName', 'accountNumber', 'currency'],
        properties: {
          accountName: { type: 'string' },
          accountNumber: { type: 'string' },
          bankCode: { type: 'string' },
          currency: { type: 'string' },
        },
      }),
      responses: { 201: jsonResponse('Added', ok({ type: 'object' })), ...commonErrors },
    },
  },
  '/app/v1/payouts/withdraw': {
    post: {
      tags: ['Super App — Payouts'],
      summary: 'Withdraw to a bank account',
      description:
        'PIN-gated and limited by KYC level. Funds are debited before the transfer is attempted and automatically returned if the bank rejects it.',
      requestBody: bodyOf({
        type: 'object',
        required: ['amount', 'currency', 'payoutAccountId', 'pin'],
        properties: {
          amount: { type: 'number' },
          currency: { type: 'string' },
          payoutAccountId: { type: 'string' },
          pin: { type: 'string' },
        },
      }),
      responses: {
        ...commonErrors,
        201: jsonResponse('Withdrawal started', ok({ $ref: '#/components/schemas/Payout' })),
        403: jsonResponse('KYC_REQUIRED | KYC_LIMIT_EXCEEDED', errorRef),
      },
    },
  },
  '/app/v1/kyc': {
    get: {
      tags: ['Super App — KYC'],
      summary: 'Verification status and level',
      responses: { 200: jsonResponse('Status', ok({ type: 'object' })), ...commonErrors },
    },
    post: {
      tags: ['Super App — KYC'],
      summary: 'Submit identity documents',
      description: 'Document numbers are encrypted at rest. Approval is a platform-admin action.',
      requestBody: bodyOf({
        type: 'object',
        required: ['documentType', 'documentNumber', 'fullName'],
        properties: {
          documentType: { type: 'string', enum: ['NIN', 'BVN', 'PASSPORT', 'DRIVERS_LICENSE', 'VOTER_ID'] },
          documentNumber: { type: 'string' },
          fullName: { type: 'string' },
        },
      }),
      responses: { 201: jsonResponse('Submitted', ok({ type: 'object' })), ...commonErrors },
    },
  },
  '/app/v1/rewards': {
    get: {
      tags: ['Super App — Rewards'],
      summary: 'Universal rewards balance',
      description: 'Cross-business points earned through Vhicasar Pay, spendable at any participating business.',
      responses: { 200: jsonResponse('Rewards', ok({ type: 'object' })), ...commonErrors },
    },
  },
} as const;

// ---- Merchant Vhicasar Pay (/api/v1/pay) ----

const merchantPayPaths = {
  '/v1/pay/sessions': {
    post: {
      tags: ['Vhicasar Pay'],
      summary: 'Create a payment session (dynamic QR)',
      description:
        'Server-issued, one-time, expiring and HMAC-signed. The amount is fixed here — clients never compute payment values.\n\n**Permission:** `vhicasar_pay.session_create`',
      requestBody: bodyOf({
        type: 'object',
        required: ['amount', 'currency'],
        properties: {
          amount: { type: 'number' },
          currency: { type: 'string' },
          description: { type: 'string' },
          expiresInSeconds: { type: 'integer', default: 300, maximum: 3600 },
          registerId: { type: 'string', description: 'Links the sale to an open POS shift' },
        },
      }),
      responses: { 201: jsonResponse('Session created', ok({ $ref: '#/components/schemas/PaymentSession' })), ...commonErrors },
    },
  },
  '/v1/pay/settlements': {
    get: {
      tags: ['Vhicasar Pay'],
      summary: 'List settlements',
      description: '**Permission:** `vhicasar_pay.read`',
      responses: { 200: jsonResponse('Settlements', ok({ type: 'array', items: { type: 'object' } })), ...commonErrors },
    },
    post: {
      tags: ['Vhicasar Pay'],
      summary: 'Create a settlement from the merchant balance',
      description: '**Permission:** `vhicasar_pay.settle`',
      responses: { 201: jsonResponse('Settlement created', ok({ type: 'object' })), ...commonErrors },
    },
  },
  '/v1/pay/settlements/{id}/payout': {
    post: {
      tags: ['Vhicasar Pay'],
      summary: 'Disburse a settlement to the bank',
      description:
        'Starts a real bank transfer. Funds move to the clearing wallet first and are returned automatically if the transfer fails.\n\n**Permission:** `vhicasar_pay.payout`',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        201: jsonResponse('Payout started', ok({ $ref: '#/components/schemas/Payout' })),
        503: jsonResponse('PAYOUTS_UNAVAILABLE — gateway not enabled for transfers', errorRef),
        ...commonErrors,
      },
    },
  },
  '/v1/pay/payouts/accounts': {
    get: {
      tags: ['Vhicasar Pay'],
      summary: 'List merchant payout accounts',
      description: '**Permission:** `vhicasar_pay.read`',
      responses: { 200: jsonResponse('Accounts', ok({ type: 'array', items: { type: 'object' } })), ...commonErrors },
    },
    post: {
      tags: ['Vhicasar Pay'],
      summary: 'Add a merchant payout account',
      description: '**Permission:** `vhicasar_pay.payout_account`',
      responses: { 201: jsonResponse('Added', ok({ type: 'object' })), ...commonErrors },
    },
  },
} as const;

// ---- Identity linking + POS + developer ----

const platformPaths = {
  '/v1/identity/customers/{customerId}/link': {
    post: {
      tags: ['Vhicasar ID'],
      summary: 'Link a customer to a Vhicasar ID',
      description:
        'Associates this organisation’s Customer record with a global identity. Identity itself is never duplicated per tenant (Database Bible §21).\n\n**Permission:** `customers.update`',
      parameters: [{ name: 'customerId', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: bodyOf({
        type: 'object',
        properties: { vhicasarPublicId: { type: 'string' }, phone: { type: 'string' } },
      }),
      responses: { 201: jsonResponse('Linked', ok({ type: 'object' })), 409: jsonResponse('Already linked', errorRef), ...commonErrors },
    },
  },
  '/v1/pos/registers': {
    get: {
      tags: ['POS'],
      summary: 'List registers',
      description: '**Permission:** `pos.read`',
      responses: { 200: jsonResponse('Registers', ok({ type: 'array', items: { type: 'object' } })), ...commonErrors },
    },
  },
  '/v1/pos/shifts/open': {
    post: {
      tags: ['POS'],
      summary: 'Open a cashier shift',
      description: '**Permission:** `pos.shift_open`',
      responses: { 201: jsonResponse('Shift opened', ok({ type: 'object' })), ...commonErrors },
    },
  },
  '/v1/developer/webhooks/deliveries': {
    get: {
      tags: ['Developer'],
      summary: 'Webhook delivery log',
      description:
        'Every attempt: status, response code, error and next retry. Deliveries are signed `HMAC-SHA256(secret, "<timestamp>.<body>")` and sent with `X-Vhicasar-Signature: t=…,v1=…`.\n\n**Permission:** `webhooks.read`',
      responses: { 200: jsonResponse('Deliveries', ok({ type: 'array', items: { type: 'object' } })), ...commonErrors },
    },
  },
  '/metrics': {
    get: {
      tags: ['Observability'],
      summary: 'Prometheus metrics',
      description: 'Plain-text exposition format. Gated by METRICS_TOKEN when configured.',
      security: [],
      responses: { 200: { description: 'Metrics' }, 401: { description: 'Token required' } },
    },
  },
} as const;

export const v2Paths = { ...appPaths, ...merchantPayPaths, ...platformPaths };

export const v2Tags = [
  { name: 'Super App — Identity', description: 'Vhicasar ID: registration, sessions, devices' },
  { name: 'Super App — Wallet', description: 'Consumer wallet: balance, top-up, transfers' },
  { name: 'Super App — Pay', description: 'QR scanning and device-signed payment confirmation' },
  { name: 'Super App — Payouts', description: 'Bank accounts and cash-out' },
  { name: 'Super App — KYC', description: 'Identity verification and limits' },
  { name: 'Super App — Rewards', description: 'Universal cross-business rewards' },
  { name: 'Vhicasar Pay', description: 'Merchant payment sessions, settlements and payouts' },
  { name: 'Vhicasar ID', description: 'Linking organisation customers to global identities' },
  { name: 'POS', description: 'Registers, shifts, cash drawers and receipts' },
  { name: 'Developer', description: 'API keys and outbound webhooks' },
  { name: 'Observability', description: 'Metrics and health' },
];
