/**
 * @file Shared workspace-id resolver.
 *
 * The MVP operates as a single-workspace deployment (Requirement 1.7),
 * so every service / route layer needs the same constant id. Until now
 * each consumer carried its own copy of {@link DEFAULT_WORKSPACE_ID}
 * and `resolveWorkspaceId` (audit nit L10). Centralising the helper
 * here keeps the contract single-sourced and gives the eventual multi-
 * workspace migration a single chokepoint to update — switch
 * {@link resolveWorkspaceId} to read the session's workspace and every
 * service / route migrates atomically.
 */

/**
 * Identifier of the default seeded workspace. Mirrors `prisma/seed.ts`.
 *
 * Exported so test fixtures can compare against the canonical value
 * without re-deriving it.
 */
export const DEFAULT_WORKSPACE_ID = 'ws_default';

/**
 * Return the active workspace id.
 *
 * Resolution order:
 *   1. `process.env.WORKSPACE_ID` when set to a non-empty string.
 *   2. {@link DEFAULT_WORKSPACE_ID} otherwise.
 *
 * Read lazily (per call) so test harnesses can mutate
 * `process.env.WORKSPACE_ID` between invocations and still observe
 * the change without restarting the module.
 */
export function resolveWorkspaceId(): string {
  const fromEnv = process.env.WORKSPACE_ID;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_WORKSPACE_ID;
}
