import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI-Native Team Workspace',
  description:
    'A collaborative workspace where human teammates and AI colleagues share channels, tasks, and approvals.',
};

/**
 * Viewport configuration. Next.js 14 expects this as a separate export
 * (no longer inside `metadata`). We pin `width=device-width,
 * initial-scale=1` so the mobile shell (P2 task #5) renders at the
 * physical viewport instead of the legacy 980px scaled fallback.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0A0A0A',
};

/**
 * Root layout — applies the dark theme globally.
 *
 * Per Requirement 9.1, the platform is dark-only with background #0A0A0A
 * and Indigo #6366F1 as the primary accent. We pin `class="dark"` on
 * <html> so Tailwind's `dark:` variants and the `bg-background` token
 * resolve consistently across server and client renders.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="min-h-screen bg-background text-foreground">{children}</body>
    </html>
  );
}
