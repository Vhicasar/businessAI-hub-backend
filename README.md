# BusinessHub AI — Backend

Standalone Express + TypeScript API (Clean Architecture, Prisma, PostgreSQL). Owns its database schema, migrations and seeds — no external workspace dependencies.

## Setup

```bash
createdb businesshub                # PostgreSQL 14+
npm install
cp .env.example .env                # set JWT_SECRET (32+ chars) + ENCRYPTION_KEY (64 hex)
npm run prisma:migrate -- --name init   # or prisma:deploy for existing migrations
npm run prisma:generate
npm run seed
npm run dev
```

API: `http://localhost:4000/api/v1` · Docs: `/api/docs` · Health: `/api/v1/health/ready`

## Scripts

| Script | Purpose |
|---|---|
| `dev` / `build` / `start` | tsx watch / tsc → dist / run production build |
| `prisma:generate` | Prisma client + regenerate `tenant-models.generated.ts` |
| `prisma:migrate` / `prisma:deploy` / `prisma:studio` | migrations & data browser |
| `seed` | permission catalog, plans, system-role sync (idempotent) |
| `typecheck` / `test` | tsc --noEmit / vitest (integration tests need `TEST_DATABASE_URL`, see docs/PHASE-7-REVIEW.md in the platform docs) |

## Docker

```bash
cp .env.docker.example .env.docker   # fill secrets
docker compose up -d --build          # API + Postgres on :4000
```

Or build just the image: `docker build -t businesshub-api .` (migrates on boot).

## Layout

```
prisma/            schema.prisma, migrations, seed.ts
src/
├── shared/        config (Zod env), logger, errors, crypto, request context,
│                  permissions catalog + role templates, socket event names
├── infrastructure/ prisma (tenant auto-scoping), channels (Telegram/WhatsApp/Meta/
│                  webchat/email), ai providers, mailer, socket.io
├── application/   use cases: auth, users, roles, customers, catalog, inventory,
│                  orders, invoices, crm, inbox, ai
├── presentation/  express middleware, /api/v1 routes, webhooks, webchat, swagger
└── main.ts        bootstrap
public/widget.js   embeddable website chat widget (served at /widget.js)
tests/             vitest unit + integration suites
```

## Conventions

- Envelope: `{ success, data }` / `{ success: false, error: { code, message, details? } }`
- Tenant scoping is automatic via the Prisma extension — never filter by `organizationId` manually
- Routes gate with `authenticate` → `requireTenant` → `requirePermission('module.action')`
- Secrets at rest: AES-256-GCM. Production JWT: RS256 (`openssl genrsa` — see .env.example)
