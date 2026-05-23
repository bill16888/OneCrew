'use client';

/**
 * Top-level error boundary required by Next.js App Router. Triggered
 * when a render in the root layout throws — a position no other
 * `error.tsx` can recover from.
 *
 * We forward the error to Sentry (no-op in dev where Sentry is
 * disabled) so production crashes are captured even before the
 * normal error pipeline runs, then render a minimal HTML shell so
 * the user is not left staring at a blank page.
 *
 * Validates: Operational concerns (P1 task #3 — error monitoring).
 */

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          backgroundColor: '#0A0A0A',
          color: '#F5F5F5',
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <div style={{ maxWidth: 480, padding: '2rem', textAlign: 'center' }}>
          <h2 style={{ marginBottom: '0.5rem' }}>Something went wrong</h2>
          <p style={{ color: '#A1A1AA', marginBottom: '1.5rem' }}>
            An unexpected error has occurred. The team has been notified.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              backgroundColor: '#6366F1',
              color: 'white',
              border: 0,
              borderRadius: '0.375rem',
              padding: '0.5rem 1.25rem',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
