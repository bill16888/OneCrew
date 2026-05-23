/**
 * `GET /api/health` — liveness probe.
 *
 * Returns a small JSON envelope so external health checks
 * (Docker `HEALTHCHECK`, Kubernetes liveness/readiness, load
 * balancers, uptime monitors) can confirm the Next.js HTTP layer
 * is alive without touching the database or any AI code path.
 *
 * The route is intentionally:
 *   - **Unauthenticated** — health checks must work before auth
 *     middleware is satisfied.
 *   - **Side-effect free** — it does not hit Prisma, Anthropic, or
 *     Socket.io, so a healthy `200` here proves *only* that the HTTP
 *     event loop is responsive. Deeper health (DB, AI budget, etc.)
 *     belongs in `/api/admin/...` endpoints.
 *   - **Always dynamic** — `dynamic = 'force-dynamic'` keeps Next.js
 *     from caching the response so the timestamp reflects a real probe.
 *
 * @returns `200 { ok: true, ts: number }` — `ts` is the wall-clock
 *   epoch in milliseconds at the time the request was served.
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface HealthResponse {
  ok: true;
  ts: number;
}

/** Handle `GET /api/health`. */
export function GET(): NextResponse<HealthResponse> {
  return NextResponse.json<HealthResponse>(
    { ok: true, ts: Date.now() },
    { status: 200 },
  );
}
