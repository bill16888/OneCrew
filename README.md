# OneCrew

OneCrew is an AI-native team workspace where human teammates and AI colleagues work together in shared channels, a Kanban board, approval flows, and operator dashboards.

The project is an MVP for experimenting with multi-agent collaboration in a real product surface. It uses a custom Next.js server so the web app, Socket.io realtime layer, and agentic loop run in one Node process.

[![CI](https://github.com/bill16888/OneCrew/actions/workflows/ci.yml/badge.svg)](https://github.com/bill16888/OneCrew/actions/workflows/ci.yml)
[![Deploy to Railway](https://github.com/bill16888/OneCrew/actions/workflows/deploy.yml/badge.svg)](https://github.com/bill16888/OneCrew/actions/workflows/deploy.yml)

## Features

- Shared channels for human and AI teammate conversations.
- AI colleague runtime with OpenAI-compatible providers.
- Four-column Kanban board for team tasks.
- Approval workflow for AI-proposed actions.
- Realtime updates through Socket.io.
- Operator dashboard for activity, approvals, and AI budget status.
- Prisma/PostgreSQL data layer with seed data for local demos.
- Docker and Railway deployment support.

## Tech Stack

- Next.js 15 App Router
- React 19
- TypeScript
- Tailwind CSS 4
- Prisma 6 and PostgreSQL
- Socket.io
- NextAuth.js
- Vitest and Playwright
- Docker, GitHub Actions, and Railway

## Project Status

OneCrew is early-stage software. It is useful for demos, research, and iteration, but you should review the deployment checklist before running it in production.

The current repository focuses on:

- AI teammate collaboration loops
- channel knowledge and project-doc tools
- bounded AI-to-AI task handoff
- deployment hardening for Railway and Docker

## Quick Start

Requirements:

- Node.js 20+
- npm
- PostgreSQL 14+ or Docker
- An API key for DeepSeek, OpenAI, or another OpenAI-compatible provider

Install dependencies:

```bash
npm install
```

Create a local environment file:

```bash
cp .env.example .env
```

Edit `.env` and set at least:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/ai_workspace?schema=public"
NEXTAUTH_SECRET="replace-with-at-least-32-random-characters"
DEEPSEEK_API_KEY="sk-your-key"
```

Prepare the database:

```bash
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
```

Start the development server:

```bash
npm run dev
```

Open `http://localhost:3000`.

## Demo Accounts

After running `npm run prisma:seed` in development, these demo human users are available:

| User | Email | Password |
| --- | --- | --- |
| Alice | `alice@example.com` | `password123` |
| Bob | `bob@example.com` | `password123` |
| Mia | `mia@example.com` | `password123` |

The default AI teammates are Ada and Hopper. AI users do not log in directly.

Do not use the demo password in production. Production seeding requires `SEED_HUMAN_PASSWORD`.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the custom Next.js + Socket.io server. |
| `npm run build` | Generate Prisma client and build the app. |
| `npm run start` | Start the production server wrapper. |
| `npm run lint` | Run the project linter. |
| `npm run typecheck` | Run TypeScript without emitting files. |
| `npm run test` | Run Vitest tests. |
| `npm run test:e2e` | Run Playwright end-to-end tests. |
| `npm run prisma:generate` | Generate Prisma client. |
| `npm run prisma:migrate` | Apply local development migrations. |
| `npm run prisma:seed` | Seed demo workspace data. |
| `npm run docker:build` | Build the production Docker image. |
| `npm run docker:up` | Start the production Docker Compose stack. |
| `npm run docker:logs` | Tail production app logs. |

## Environment

The app validates environment variables at startup through `lib/env.ts`.

Important variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. |
| `NEXTAUTH_SECRET` | NextAuth signing secret, at least 32 characters. |
| `NEXTAUTH_URL` | Public app URL. |
| `AI_PROVIDER` | `deepseek`, `openai`, or `custom`. Defaults to `deepseek`. |
| `DEEPSEEK_API_KEY` | Required when `AI_PROVIDER=deepseek`. |
| `OPENAI_API_KEY` | Required when `AI_PROVIDER=openai`. |
| `AI_PROVIDER_API_KEY` | Required when `AI_PROVIDER=custom`. |
| `AI_DAILY_BUDGET_USD` | Daily AI budget circuit breaker. |
| `NEXT_PUBLIC_SOCKET_URL` | Browser Socket.io endpoint. Defaults to same origin when empty. |
| `SEED_HUMAN_PASSWORD` | Required for production seed data. |

Use `.env.example` for development and `.env.production.example` as a production checklist.

## Deployment

### Docker Compose

Create `.env.prod`, then run:

```bash
npm run docker:build
npm run docker:up
npm run docker:logs
```

The Docker Compose stack runs:

- `app` on port `3000`
- PostgreSQL 16 on the private compose network
- Redis 7 on the private compose network

### Railway

The repository includes `railway.toml` and a GitHub Actions deployment workflow.

Minimum Railway variables:

- `DATABASE_URL`
- `REDIS_URL`
- `NEXTAUTH_SECRET`
- `NEXTAUTH_URL`
- `NEXT_PUBLIC_SOCKET_URL`
- provider API key, for example `DEEPSEEK_API_KEY`
- `AI_DAILY_BUDGET_USD`

To enable automatic deploys from GitHub Actions, add `RAILWAY_TOKEN` in:

`Settings -> Secrets and variables -> Actions`

The deploy workflow is intentionally token-gated. If `RAILWAY_TOKEN` is missing, the workflow succeeds and logs a warning instead of failing the whole push.

## Repository Layout

```text
app/          Next.js routes, layouts, and global styles
components/   UI components for channels, board, approvals, dashboard
hooks/        React hooks
lib/          services, AI runtime, realtime, auth, environment, utilities
prisma/       schema, migrations, and seed script
scripts/      deployment, backup, and Railway startup scripts
store/        Zustand stores
tests/        Vitest unit and integration tests
e2e/          Playwright end-to-end tests
```

## Contributing

Contributions and issue reports are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Security

Please do not open public issues for security vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
