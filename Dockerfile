# syntax=docker/dockerfile:1.6
#
# AI-Native Team Workspace — production container.
#
# Three-stage build to keep the runtime image small and free of build
# tooling:
#
#   1. deps    — install npm dependencies (incl. devDeps for the build).
#   2. builder — generate Prisma client, run `next build`.
#   3. runner  — copy the build artifacts + production node_modules and
#                run the custom server (Next.js + Socket.io + Agentic Loop).
#
# The custom `server.ts` orchestrates Next.js HTTP, Socket.io, and the
# Agentic Loop in a single process (see design.md → "进程拓扑"). We
# execute it via `tsx` instead of pre-compiling to `server.js` because
# the file imports both server-only Node modules (`socket.io`,
# `next-auth/jwt`) and `@/...` aliases configured in `tsconfig.json` —
# `tsx` resolves both at runtime without an extra tsc step.

# ----------------------------------------------------------------------
# Stage 1 — install all npm dependencies (including dev) for the build
# ----------------------------------------------------------------------
FROM node:20-alpine AS deps

WORKDIR /app

# Install OS deps required by Prisma and node-gyp at build time.
RUN apk add --no-cache libc6-compat openssl

COPY package.json package-lock.json .npmrc ./
# `--no-audit` and `--no-fund` keep build logs clean; `--prefer-offline`
# uses the cache aggressively. `legacy-peer-deps` is honoured via the
# committed `.npmrc` (see file-level comment there for why).
RUN npm ci --no-audit --no-fund

# ----------------------------------------------------------------------
# Stage 2 — generate Prisma client and build Next.js
# ----------------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache libc6-compat openssl

# Build-time placeholder env vars.
#
# `next build` evaluates server modules (including `lib/env.ts`) at
# compile time to discover routes / generate static pages. `lib/env.ts`
# uses zod to assert that required vars are present and `process.exit(1)`s
# if any is missing — which would crash the build inside the Railway
# Docker build environment, where the real prod secrets are NOT yet
# injected (Railway only mounts service variables at *runtime*).
#
# We supply synthetic values that satisfy the schema at build time:
#   - DATABASE_URL        — any non-empty string
#   - DEEPSEEK_API_KEY    — any non-empty string
#   - NEXTAUTH_SECRET     — must be ≥ 32 chars (zod rule)
#
# These are NEVER read at runtime: the real values from Railway's
# Variables panel take precedence the moment the container starts.
# The runtime container in stage 3 does not inherit these ENVs (it
# only copies `.next/`, `node_modules/`, etc.), so there is no risk
# of leaking the placeholders into production behaviour.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public" \
    DEEPSEEK_API_KEY="sk-build-time-placeholder-replaced-at-runtime" \
    NEXTAUTH_SECRET="build-time-placeholder-32-characters-minimum-length"

# Reuse the pre-installed node_modules from the deps stage so we do not
# re-run npm ci here. Anything written by `next build` lands in `.next/`.
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate the Prisma client first so the build can `import { ... } from
# '@prisma/client'` without falling back to the default stub. Then build
# Next.js — `output` defaults to the standard `.next/` directory.
RUN npx prisma generate
RUN npm run build

# ----------------------------------------------------------------------
# Stage 3 — minimal production runtime
# ----------------------------------------------------------------------
FROM node:20-alpine AS runner

WORKDIR /app

# OpenSSL is needed by both Prisma and bcryptjs at runtime; libc6-compat
# keeps native modules happy on Alpine. postgresql16-client provides
# `pg_dump` for the nightly backup cron (`scripts/backup.ts`); the
# version is kept in lock-step with the postgres image declared in
# `docker-compose.prod.yml`.
RUN apk add --no-cache libc6-compat openssl tini postgresql16-client

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Run as a non-root user for least privilege.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# Copy the build artifacts. We copy `node_modules` from `deps` because
# the build itself does not prune devDependencies; for an image
# absolutely free of devDeps you can switch to `npm ci --omit=dev` here.
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/server.ts ./server.ts
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=nextjs:nodejs /app/lib ./lib
COPY --from=builder --chown=nextjs:nodejs /app/app ./app
COPY --from=builder --chown=nextjs:nodejs /app/components ./components
COPY --from=builder --chown=nextjs:nodejs /app/store ./store
COPY --from=builder --chown=nextjs:nodejs /app/hooks ./hooks
COPY --from=builder --chown=nextjs:nodejs /app/types ./types
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/middleware.ts ./middleware.ts
COPY --from=builder --chown=nextjs:nodejs /app/next.config.mjs ./next.config.mjs
COPY --from=builder --chown=nextjs:nodejs /app/next-env.d.ts ./next-env.d.ts

USER nextjs

EXPOSE 3000

# `tini` reaps zombie processes and forwards SIGTERM cleanly so the
# server.ts shutdown handler (AgenticLoop.stop / io.close / httpServer.close)
# actually fires when `docker stop` is issued.
ENTRYPOINT ["/sbin/tini", "--"]

# Apply pending Prisma schema changes after normalising Railway env vars,
# then boot the custom server. The wrapper accepts either DATABASE_URL,
# common Railway/Postgres URL aliases, or PGHOST/PGUSER/PGPASSWORD style
# variables before it invokes Prisma.
#
# Schema migration strategy is controlled by `PRISMA_DEPLOY_STRATEGY`:
#   - default (unset / "migrate"): run `prisma migrate deploy`, which
#     applies the version-controlled migration history under
#     `prisma/migrations/`. If a database that was previously managed
#     by `db push` is encountered (Prisma error P3005), the wrapper
#     auto-baselines by marking each existing migration as applied,
#     then retries `migrate deploy` (which then becomes a no-op).
#   - "push": fall back to `prisma db push --accept-data-loss`. This
#     is destructive on schema changes and should only be used for
#     greenfield bootstraps. Set this temporarily in Railway when
#     starting from an empty database for the first time.
#
# `set -e` ensures a non-zero exit from the wrapper surfaces as a
# container crash with a clear error, instead of being swallowed.
CMD ["sh", "-c", "set -e; exec node_modules/.bin/tsx scripts/railway-start.ts"]
