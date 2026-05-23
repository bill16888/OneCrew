/**
 * Custom server entry point.
 *
 * In the MVP, the entire stack runs inside a single Node.js process:
 * Next.js HTTP, Socket.io realtime, and (later) the Agentic Loop tick all
 * share the same {@link http.Server}. This file is the only entry point
 * that wires those pieces together. See design.md →
 * "Architecture / 进程拓扑（单进程 server.ts）" for the full diagram.
 *
 * Boot sequence (matches design.md):
 *   1. `next({ dev, hostname, port })` builds the Next.js app shell.
 *   2. `app.prepare()` resolves the App Router and warms up the dev/
 *      production bundle.
 *   3. `createServer((req, res) => handler(req, res))` bridges the raw
 *      Node HTTP server to Next's request handler.
 *   4. `createIOServer(httpServer)` attaches Socket.io to the same HTTP
 *      server so realtime traffic shares the application port (the
 *      handshake middleware that performs the NextAuth session check
 *      is registered inside `createIOServer`, so the call site sees a
 *      ready-to-use {@link AppIOServer}).
 *   5. `AgenticLoop.start(io)` boots the periodic AI decision-cycle
 *      scheduler (30 s tick + approval-driven wakeup listener). Wiring
 *      it *after* the Socket.io middleware is registered guarantees
 *      that the first cycle's realtime broadcasts (`ai:thinking`,
 *      `message:new`, `task:updated`, `approval:created`) flow over a
 *      fully-authenticated IO instance.
 *   6. `httpServer.listen(port)` starts accepting traffic.
 *
 * Shutdown sequence (on SIGINT / SIGTERM):
 *   1. `AgenticLoop.stop()` clears the 30 s `setInterval` and detaches
 *      the wakeup listener so no new cycles are scheduled. In-flight
 *      cycles are allowed to finish (they hold their own `inFlight`
 *      guards) and emit their final `ai:thinking{state:false}` before
 *      we drain Socket.io.
 *   2. `io.close()` to drain Socket.io connections.
 *   3. `httpServer.close()` to stop accepting new HTTP requests and let
 *      in-flight ones finish.
 *   4. `process.exit(0)` once both close callbacks fire.
 *
 * Configuration:
 *   - `process.env.PORT`        → port (default `3000`).
 *   - `process.env.NODE_ENV`    → `dev` is `true` unless this equals
 *                                  `'production'`.
 *   - `hostname`                → `'localhost'` (single-host MVP).
 *
 * Validates: Requirements 7.8, 8.1
 */

import '@/lib/env';

import { createServer } from 'node:http';
import next from 'next';

import { env } from './lib/env';
import { logger } from './lib/logger';
import { AgenticLoop } from './lib/loop/agentic-loop';
import { createIOServer } from './lib/realtime/io';

/** Whether Next.js should run in development mode (HMR, source maps, etc.). */
const dev = env.NODE_ENV !== 'production';

/** Bind hostname for the HTTP server. The MVP runs on a single host. */
const hostname = 'localhost';

/** Listen port. Honors `PORT` env override; defaults to 3000. */
const port = Number.parseInt(process.env.PORT ?? '', 10) || 3000;

/**
 * Bootstrap the combined HTTP + Socket.io server.
 *
 * Wrapped in a top-level async function so we can `await app.prepare()` and
 * surface preparation failures (missing `.next` build, port collision, bad
 * config, …) through a single try/catch. On failure the process exits with
 * code 1 so the supervisor (or `tsx watch`) can react.
 */
async function bootstrap(): Promise<void> {
  const app = next({ dev, hostname, port });
  const handler = app.getRequestHandler();

  try {
    await app.prepare();

    const httpServer = createServer((req, res) => {
      // Delegate every HTTP request to Next.js. URL parsing is handled
      // internally by `getRequestHandler()` in Next 14, so we forward the
      // raw req/res unchanged.
      void handler(req, res);
    });

    // Attach Socket.io to the same HTTP server. The IO instance is held by
    // the singleton in `lib/realtime/io.ts` and read via `getIO()` from
    // service-layer broadcasts; we keep the local binding to hand it to
    // the Agentic Loop below and to drain Socket.io during shutdown. The
    // handshake middleware wired inside `createIOServer` performs the
    // real NextAuth session check, so unauthenticated connections are
    // rejected here without any additional setup at this call site.
    const io = createIOServer(httpServer);

    // Boot the Agentic Loop *after* the Socket.io middleware is wired
    // (so the very first cycle's realtime broadcasts flow over an
    // authenticated IO instance) and *before* `httpServer.listen` (so
    // the scheduler is alive the moment the port starts accepting
    // traffic). `start` installs a 30 s `setInterval` and an
    // approval-driven wakeup listener on `agenticEmitter`; both are
    // torn down by `stop()` in the shutdown handler below.
    AgenticLoop.start(io);

    httpServer.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`> Ready on http://${hostname}:${port}`);

      // Boot the daily backup cron lazily so its dependencies (`node-cron`,
      // `@aws-sdk/client-s3`) are only loaded once the server is healthy.
      // Failures here are non-fatal — the cron module logs `warn` and
      // self-skips when backup env vars are missing.
      import('./scripts/backup-cron').catch((err: unknown) => {
        logger.warn(
          { event: 'backup_cron_load_failed', err },
          'Backup cron failed to start',
        );
      });
    });

    // Graceful shutdown. Both signals share the same handler so we can
    // tear the stack down in the reverse order it was built up. The
    // handler is registered exactly once per signal to avoid repeated
    // `shutdown()` calls if the process receives the same signal twice
    // (e.g. user mashing Ctrl+C in the terminal).
    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      // eslint-disable-next-line no-console
      console.log(`\n${signal} received, shutting down...`);

      // Stop the Agentic Loop before draining sockets so the periodic
      // tick and the wakeup listener cannot start a new cycle mid-
      // shutdown. In-flight cycles keep their own `inFlight` guard and
      // are allowed to run to completion; their final
      // `ai:thinking{state:false}` broadcast still flows because we
      // close Socket.io after this call.
      AgenticLoop.stop();

      // Close Socket.io first to stop emitting new events, then close the
      // underlying HTTP server. Both calls are async; we exit after the
      // HTTP server reports it has finished draining.
      io.close(() => {
        httpServer.close((err) => {
          if (err) {
            // eslint-disable-next-line no-console
            console.error('Error during httpServer.close:', err);
            process.exit(1);
            return;
          }
          process.exit(0);
        });
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    // Any failure during `app.prepare()` or HTTP/Socket.io setup is fatal:
    // there is no degraded mode the MVP can run in (Next.js, Socket.io and
    // the Agentic Loop all share this process). Log and exit so the
    // surrounding supervisor restarts us.
    // eslint-disable-next-line no-console
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

void bootstrap();
