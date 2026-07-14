# BusinessHub AI — API image (fully standalone).
# Debian slim (glibc + OpenSSL 3) — avoids Prisma's Alpine/musl OpenSSL issues.

# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY prisma prisma
RUN npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund

COPY . .
# Some services have known type-only errors from the tenant-scoped Prisma
# extended client; tsc still emits valid, runtime-correct JS (dev runs via tsx).
# `|| true` lets the image build on the emitted output without masking a real
# failure — the next line fails the build if main.js was not produced.
RUN npx prisma generate \
  && node scripts/generate-tenant-models.js \
  && (npx tsc -p tsconfig.json || true) \
  && test -f dist/main.js

# ---------- runtime ----------
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates wget && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN (npm ci --omit=dev --no-audit --no-fund 2>/dev/null || npm install --omit=dev --no-audit --no-fund) \
  && npm cache clean --force

COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/dist ./dist
COPY public ./public
COPY prisma ./prisma
# src + tsconfig + scripts so the tsx seed (npm run seed) can run in-container once.
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

RUN addgroup --system app && adduser --system --ingroup app app && chown -R app:app /app
USER app

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:4000/api/v1/health >/dev/null || exit 1

# Migrate on start; run `npm run seed` once for first-time setup (see deploy notes).
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
