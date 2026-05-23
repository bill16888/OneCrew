# AI-Native Team Workspace

MVP for a collaborative workspace where human teammates and AI colleagues share channels, a 4-column Kanban board, and an approval workflow. Built on Next.js 14 (App Router) + TypeScript + Tailwind + shadcn/ui + Socket.io + Prisma + PostgreSQL + DeepSeek (via the OpenAI-compatible chat completions SDK) + NextAuth.js.

The full architecture, requirements, and task plan live under `.kiro/specs/ai-native-team-workspace/`.

## Status

Task **1.1** complete: Next.js 14 + TypeScript + Tailwind + shadcn/ui scaffold with dark-theme tokens. Database schema, auth, Socket.io server, AI runtime, and agentic loop are scaffolded in subsequent tasks.

## Prerequisites

- Node.js 20+
- PostgreSQL 14+ (or Docker)
- A DeepSeek API key (https://platform.deepseek.com)

## Setup

```powershell
# 1. Install dependencies
npm install

# 2. Configure environment
Copy-Item .env.example .env
# then edit .env: set DATABASE_URL, NEXTAUTH_SECRET, DEEPSEEK_API_KEY

# 3. Generate the Prisma client + run migrations (added in task 1.2)
npm run prisma:generate
npm run prisma:migrate

# 4. Seed the workspace (added in task 1.3)
npm run prisma:seed

# 5. Start the dev server (Next.js + Socket.io + Agentic Loop on one port)
npm run dev
```

The custom entrypoint `server.ts` (added in task 3.7) hosts Next.js, Socket.io, and the agentic loop in a single Node process. Until then, `npm run dev` will fall back to whatever entrypoint is wired in.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the dev server (custom `server.ts` via `tsx watch`). |
| `npm run build` | Build the Next.js production bundle. |
| `npm run start` | Run the production server. |
| `npm run lint` | Lint with `next lint`. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run test` | Run Vitest (unit + property-based via `fast-check`). |
| `npm run prisma:generate` | Regenerate the Prisma client. |
| `npm run prisma:migrate` | Apply Prisma migrations in dev. |
| `npm run prisma:seed` | Seed the hardcoded workspace, users, and channels. |
| `npm run docker:build` | Build the production image as `ai-workspace`. |
| `npm run docker:up` | Bring up the full prod stack with `docker-compose.prod.yml`. |
| `npm run docker:logs` | Tail the `app` service logs in the running prod stack. |

## Production deployment (Docker)

The repository ships a multi-stage `Dockerfile` plus a
`docker-compose.prod.yml` that brings up the app alongside PostgreSQL
and Redis on a private bridge network. PostgreSQL and Redis are kept
internal — only port `3000` (the Next.js + Socket.io + Agentic Loop
process) is published to the host.

```powershell
# 1. Author the production environment file. Mirror .env.example and
#    set DEEPSEEK_API_KEY, NEXTAUTH_SECRET (≥ 32 chars), AI_DAILY_BUDGET_USD,
#    NEXTAUTH_URL, etc. lib/env.ts validates everything at startup.
Copy-Item .env.example .env.prod
# then edit .env.prod with real production secrets

# 2. Build the image (alias for `docker build -t ai-workspace .`).
npm run docker:build

# 3. Start the stack in the background.
npm run docker:up

# 4. Tail the app service logs.
npm run docker:logs
```

The container's `CMD` runs `npx prisma migrate deploy` before booting
the custom server, so schema migrations always reach the database
before any traffic is served. A liveness probe is exposed at
`GET /api/health` (returns `{ ok: true, ts: <epoch_ms> }`).

To tear the stack down: `docker-compose -f docker-compose.prod.yml down`
(add `--volumes` to also drop the `pg_data` / `redis_data` named volumes).

Sentry: 在 sentry.io 创建 Next.js 项目，将 DSN 填入 .env.prod

### Railway 部署 + GitHub Actions CI/CD

`railway.toml` 让 Railway 直接消费仓库里的 `Dockerfile` 构建镜像，并在容器内串联 `prisma migrate deploy` 与 `npx tsx server.ts` 启动；健康检查打到 `/api/health`，重启策略 `ON_FAILURE` × 3。

部署步骤：

1. 在 [railway.app](https://railway.app) 创建项目，**Link** 到本 GitHub 仓库（Railway 会探测到 `railway.toml` 并自动选 Dockerfile 构建器）。
2. 在 Railway 控制台为该项目添加 **PostgreSQL** 与 **Redis** plugin，Railway 会注入 `DATABASE_URL` / `REDIS_URL` 到 service 的环境变量。
3. 把 `.env.example` 中其余必需变量在 Railway 控制台 → **Variables** 里逐项配置（最少：`DEEPSEEK_API_KEY`、`NEXTAUTH_SECRET`（≥32 字符）、`NEXTAUTH_URL`、`NEXT_PUBLIC_SOCKET_URL`、`AI_DAILY_BUDGET_USD`，可选 `DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`、`NEXT_PUBLIC_SENTRY_DSN`、`BACKUP_*`）。
4. 在 GitHub 仓库 **Settings → Secrets and variables → Actions** 里添加：
   - `RAILWAY_TOKEN` — Railway 控制台 → Account → Tokens 生成
5. `git push` 到 `main` 分支：
   - `.github/workflows/ci.yml` 跑 `npm ci → prisma generate → typecheck → lint`
   - `.github/workflows/deploy.yml` 紧随其后调用 `railway up --detach`
6. 部署完成后访问 `https://<your-service>.railway.app/api/health`，看到 `{"ok":true,"ts":...}` 即代表健康检查通过。

## Seed data

`npm run prisma:seed` provisions the single workspace defined in
`.env` (`WORKSPACE_ID`, default `ws_default`) and is idempotent (safe to re-run).

| Role | Email | Password | `isAI` | `aiRole` |
| --- | --- | --- | --- | --- |
| Human | `alice@example.com` | `password123` | `false` | – |
| Human | `bob@example.com` | `password123` | `false` | – |
| Human | `mia@example.com` | `password123` | `false` | – |
| AI | `ada@ai.local` | (no password) | `true` | `Ada` |
| AI | `hopper@ai.local` | (no password) | `true` | `Hopper` |

Default channels: `#general`, `#engineering`. AI users have `passwordHash = null`
and cannot log in; they act through the AI runtime only.

## Visual tokens (Requirements 9.1 – 9.3)

- Background: `#0A0A0A` (`bg-background`)
- Primary: Indigo `#6366F1` (`bg-primary`, `text-primary`)
- AI accent: Purple `#A855F7` (`bg-ai`)
- AI Badge gradient: `#A855F7 → #6366F1` (`bg-ai-gradient`)
- AI message left accent bar: `border-l-2 border-ai`

## Project layout

```
app/                  Next.js App Router pages + layouts + globals.css
components/           UI components (channel, board, approval, ui/AIBadge)
lib/                  Services, AI runtime, realtime, loop, prisma client, utils
store/                Zustand stores
prisma/               schema.prisma + seed.ts
server.ts             Custom Next.js + Socket.io + Agentic Loop entrypoint
```

## Spec

- Requirements: `.kiro/specs/ai-native-team-workspace/requirements.md`
- Design: `.kiro/specs/ai-native-team-workspace/design.md`
- Tasks: `.kiro/specs/ai-native-team-workspace/tasks.md`
