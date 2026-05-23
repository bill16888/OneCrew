'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';
import {
  Suspense,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react';

/**
 * Default landing page for newly authenticated users when no
 * `callbackUrl` is supplied via query string. The middleware
 * (`middleware.ts`) treats every non-public path as protected, so the
 * workspace home (`/`) is always a valid post-login destination.
 */
const DEFAULT_REDIRECT: string = '/';

/**
 * Whitelist a `callbackUrl` to a same-origin, same-app pathname.
 *
 * NextAuth's redirect flow already constrains the URL on the server,
 * but `signIn(..., { redirect: false })` hands control of navigation
 * back to us. We narrow the value to a plain root-relative path so a
 * malicious or malformed query string can't bounce the user to an
 * external origin or to a protocol-relative URL like `//evil.com`.
 *
 * @param raw value pulled from `useSearchParams().get('callbackUrl')`.
 * @returns a safe, root-relative pathname; falls back to {@link DEFAULT_REDIRECT}.
 */
function safeCallbackUrl(raw: string | null): string {
  if (raw === null || raw === '') return DEFAULT_REDIRECT;
  // Disallow protocol-relative (`//host`) and absolute URLs entirely.
  if (!raw.startsWith('/') || raw.startsWith('//')) return DEFAULT_REDIRECT;
  return raw;
}

/**
 * Inner login form. Split out from {@link LoginPage} so that
 * `useSearchParams()` can sit behind a `<Suspense>` boundary, which is
 * the pattern Next.js 14 recommends for client-side query-string reads
 * inside an App Router page.
 */
function LoginForm(): ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl: string = safeCallbackUrl(
    searchParams?.get('callbackUrl') ?? null,
  );

  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // Disable submit until both fields carry non-whitespace input, or
  // while a request is in flight. We also keep the disabled state
  // honest while submitting so users can't double-click the button.
  const isSubmitDisabled: boolean =
    isSubmitting || email.trim() === '' || password === '';

  /**
   * Submit handler — wires the form into NextAuth's Credentials
   * provider via `signIn('credentials', { redirect: false })`.
   *
   * Behaviour matches Requirement 1.1/1.3/1.4:
   *  - On `result.error` (or `!result.ok`), we stay on this page and
   *    surface a generic "Invalid email or password" message. We
   *    intentionally avoid leaking whether the email exists.
   *  - On `result.ok === true`, we navigate to the original
   *    `callbackUrl` (sanitised by {@link safeCallbackUrl}) or to the
   *    workspace home as fallback.
   *  - Network / unexpected errors are caught locally and surfaced as
   *    a friendly retry message; the loading flag is always reset in
   *    `finally` so the form stays usable.
   */
  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (isSubmitDisabled) return;

    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const result = await signIn('credentials', {
        email: email.trim(),
        password,
        redirect: false,
        callbackUrl,
      });

      if (!result || result.error || !result.ok) {
        setErrorMessage('Invalid email or password');
        return;
      }

      // `result.url` may carry the resolved callback from NextAuth; we
      // still prefer our sanitised value to avoid trusting any
      // server-echoed URL blindly. `replace` keeps the login route out
      // of the back-button history.
      router.replace(callbackUrl);
      router.refresh();
    } catch {
      setErrorMessage('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={handleSubmit} noValidate>
      <div className="space-y-1.5">
        <label
          htmlFor="email"
          className="block text-sm font-medium text-foreground"
        >
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          disabled={isSubmitting}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-border bg-surface-raised px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
          placeholder="you@example.com"
        />
      </div>

      <div className="space-y-1.5">
        <label
          htmlFor="password"
          className="block text-sm font-medium text-foreground"
        >
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          disabled={isSubmitting}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-md border border-border bg-surface-raised px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
          placeholder="••••••••"
        />
      </div>

      {/*
        Error region — controlled by `errorMessage`. Rendered with
        role="alert" + aria-live so screen readers announce the message
        whenever it changes. The min-height keeps layout stable so the
        button doesn't jump when the message appears or disappears.
      */}
      <div
        role="alert"
        aria-live="polite"
        data-testid="login-error"
        className="min-h-[1.25rem] text-sm text-destructive"
      >
        {errorMessage ?? ''}
      </div>

      <button
        type="submit"
        disabled={isSubmitDisabled}
        aria-busy={isSubmitting}
        className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-600 focus:outline-none focus:ring-2 focus:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isSubmitting ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

/**
 * `/login` page (task 4.3).
 *
 * Renders a dark-themed credentials form and wires submission into
 * `next-auth/react`'s `signIn('credentials', { redirect: false })`.
 * The page handles three branches explicitly:
 *
 *  1. **Failure** — `result.error` is truthy or `result.ok` is false.
 *     We stay on the login page and surface a generic
 *     "Invalid email or password" message, satisfying Requirements
 *     1.1 and 1.3.
 *  2. **Success** — `result.ok === true`. We navigate via
 *     `router.replace()` to either the sanitised `callbackUrl` query
 *     param (set by `next-auth/middleware` when redirecting an
 *     unauthenticated user) or to the workspace home `/`, satisfying
 *     Requirement 1.4. `replace` is preferred over `push` so the login
 *     URL doesn't end up in browser history.
 *  3. **Loading** — while the request is in flight, both inputs and
 *     the submit button are disabled and the button label switches to
 *     "Signing in…", with `aria-busy="true"` for assistive tech.
 *
 * `useSearchParams()` is colocated with the form inside a
 * `<Suspense>` boundary because Next.js 14's App Router opts client
 * components that read query params into a deferred render path. The
 * static fallback intentionally mirrors the form chrome so the page
 * doesn't visibly flash empty during hydration.
 *
 * Validates: Requirements 1.1, 1.3, 1.4.
 */
export default function LoginPage(): ReactElement {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-16 text-foreground">
      <section className="w-full max-w-sm rounded-lg border border-border bg-surface p-8 shadow-lg">
        <header className="mb-6 space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            AI-Native Team Workspace
          </h1>
          <p className="text-sm text-muted-foreground">
            Sign in to your workspace.
          </p>
        </header>

        <Suspense fallback={<LoginFormFallback />}>
          <LoginForm />
        </Suspense>
      </section>
    </main>
  );
}

/**
 * Static skeleton shown while the `LoginForm` Suspense boundary
 * resolves. Mirrors the live form's chrome so the page doesn't shift
 * once the client component hydrates.
 */
function LoginFormFallback(): ReactElement {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="space-y-1.5">
        <div className="h-4 w-12 rounded bg-surface-raised" />
        <div className="h-9 w-full rounded-md border border-border bg-surface-raised" />
      </div>
      <div className="space-y-1.5">
        <div className="h-4 w-16 rounded bg-surface-raised" />
        <div className="h-9 w-full rounded-md border border-border bg-surface-raised" />
      </div>
      <div className="min-h-[1.25rem]" />
      <div className="h-9 w-full rounded-md bg-primary/60" />
    </div>
  );
}
