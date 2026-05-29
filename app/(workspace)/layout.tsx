import type { ReactNode } from 'react';

import { getServerSession } from 'next-auth';

import {
  ApprovalCenter,
  type AIUserDirectory,
} from '@/components/approval/ApprovalCenter';
import { MobileHeader } from '@/components/layout/MobileHeader';
import { NotificationPermissionBanner } from '@/components/notifications/NotificationPermissionBanner';
import { NotificationProvider } from '@/components/notifications/NotificationProvider';
import { Sidebar } from '@/components/layout/Sidebar';
import { authOptions } from '@/lib/auth/options';
import prisma from '@/lib/prisma';
import type { ApprovalCreatedPayload } from '@/lib/realtime/events';

/**
 * `(workspace)` route group layout — the shell every authenticated
 * workspace view shares.
 *
 * The `(workspace)` segment is a Next.js route group: it does **not**
 * appear in the URL. So this layout wraps:
 *   - `/`                       (workspace home, `(workspace)/page.tsx`)
 *   - `/channels/[channelId]`   (channel view, task 2.4)
 *   - `/board`                  (kanban view, task 2.5)
 *
 * Layout contract (Requirements 2.1, 3.1, 9.1):
 *   - 240px fixed sidebar on the left (dark surface) listing channels,
 *     AI teammates, and the kanban board entry.
 *   - Main content area takes the remaining width and scrolls
 *     independently so the sidebar stays put.
 *
 * Task 9.5 also mounts a single workspace-wide
 * {@link ApprovalCenter}: it subscribes to the `approval:created`
 * realtime event and surfaces an {@link ApprovalDialog} for every
 * PENDING approval (Requirements 6.1, 6.3, 6.4, 6.7). Mounting it at
 * the layout level (rather than inside individual pages) ensures
 * approvals are visible regardless of which workspace view the user is
 * currently on.
 */

const DEFAULT_WORKSPACE_ID = 'ws_default';

/**
 * Resolve the active workspace id, mirroring the same fallback used in
 * the service layer (`approval.service.ts`, `task.service.ts`). Reading
 * the env var per-render keeps test harnesses able to swap it.
 */
function resolveWorkspaceId(): string {
  const fromEnv = process.env.WORKSPACE_ID;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_WORKSPACE_ID;
}

/**
 * Coerce a Prisma `Json` value into the wire shape consumed by
 * {@link ApprovalCreatedPayload.payload}: a keyed object or `null`.
 * Mirrors the service-layer helper so the prefetched seed and the
 * realtime stream share the same shape.
 */
function toPayloadField(
  value: unknown,
): Record<string, unknown> | null {
  if (
    value !== null &&
    value !== undefined &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return value as Record<string, unknown>;
  }
  return null;
}

export default async function WorkspaceLayout({
  children,
}: {
  children: ReactNode;
}): Promise<JSX.Element> {
  const workspaceId = resolveWorkspaceId();
  // Pull the session for header avatar rendering. We tolerate failures
  // (e.g. transient NextAuth misconfiguration) by treating the user as
  // anonymous — the layout's auth gate is enforced at `middleware.ts`.
  let userInitialSource = '?';
  try {
    const session = await getServerSession(authOptions);
    const candidate =
      session?.user?.name ?? session?.user?.email ?? '?';
    userInitialSource = candidate || '?';
  } catch {
    userInitialSource = '?';
  }

  // Prefetch every PENDING approval so a hard refresh keeps the
  // approval queue intact (including stale ones older than 24 h that
  // would otherwise only arrive via the live `approval:created` stream
  // when first created). Failing to fetch should not break the shell —
  // we degrade to an empty seed and rely on the live stream.
  let initialPending: readonly ApprovalCreatedPayload[] = [];
  let aiDirectory: AIUserDirectory = {};
  try {
    const pendingRows = await prisma.approval.findMany({
      where: { workspaceId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });

    initialPending = pendingRows.map((row) => ({
      id: row.id,
      aiUserId: row.aiUserId,
      action: row.action,
      payload: toPayloadField(row.payload),
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    }));

    // Resolve every distinct AI sender's display name so the dialog
    // renders friendly headers instead of raw cuids. Restrict to AI
    // users to keep the query bounded; the directory falls back to
    // the id at render time when an entry is missing.
    const aiUserIds = Array.from(
      new Set(initialPending.map((p) => p.aiUserId)),
    );
    if (aiUserIds.length > 0) {
      const aiUsers = await prisma.user.findMany({
        where: { id: { in: aiUserIds }, isAI: true },
        select: { id: true, name: true },
      });
      aiDirectory = Object.fromEntries(
        aiUsers.map((u) => [u.id, { name: u.name }]),
      );
    }
  } catch {
    // Swallow prefetch failures; the live socket subscription will
    // still surface new approvals as they are created.
    initialPending = [];
    aiDirectory = {};
  }

  return (
    <div className="flex h-screen w-full flex-col bg-background text-foreground md:flex-row">
      <Sidebar />
      <div className="flex min-h-0 flex-1 flex-col">
        <NotificationPermissionBanner />
        <MobileHeader userInitial={userInitialSource.charAt(0)} />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
      <ApprovalCenter
        initialPending={initialPending}
        aiDirectory={aiDirectory}
      />
      <NotificationProvider />
    </div>
  );
}
