import { create } from 'zustand';

/**
 * Cross-view UI state for the AI-Native Team Workspace.
 *
 * Per Requirement 9.6, client components managing shared state across
 * views go through a Zustand store. This store is intentionally a thin
 * skeleton: it holds **transient UI state only** (no business logic,
 * no API calls, no persistence). Server-state lives on the server and
 * arrives via Realtime events / API responses.
 *
 * Shape (per task 2.1):
 *   - currentChannelId   : which channel is currently focused
 *   - thinkingAIs        : set of AI user ids currently in `ai:thinking=true`
 *   - approvalDialog     : controls the approval modal visibility + target
 *
 * Design notes:
 *   - `thinkingAIs` is a `Set<string>` for O(1) membership checks; every
 *     mutation creates a new Set so Zustand's referential-equality based
 *     subscriptions fire correctly.
 *   - `approvalDialog.approvalId` is `null` when the dialog is closed.
 */

/** State slice — pure data. */
export interface WorkspaceState {
  /** Currently focused channel id, or null when no channel is selected. */
  currentChannelId: string | null;
  /** AI user ids whose decision cycle is in flight (driven by `ai:thinking`). */
  thinkingAIs: Set<string>;
  /** Approval modal state — `open` is true iff the user is reviewing an approval. */
  approvalDialog: ApprovalDialogState;
  /**
   * Whether the mobile (`<md`) sidebar drawer is open. Desktop layouts
   * ignore this flag (Sidebar is always visible at `md+`); mobile
   * layouts toggle it via the hamburger button in the header bar.
   *
   * Validates: P2 task #5 — mobile sidebar drawer.
   */
  isMobileSidebarOpen: boolean;
}

/** Approval dialog sub-state. */
export interface ApprovalDialogState {
  open: boolean;
  approvalId: string | null;
}

/** Action slice — synchronous mutators only. No async, no side effects. */
export interface WorkspaceActions {
  /** Switch the active channel. Pass `null` to clear selection. */
  setCurrentChannel: (channelId: string | null) => void;
  /** Mark an AI as currently thinking (idempotent). */
  addThinking: (aiUserId: string) => void;
  /** Clear an AI's thinking state (idempotent). */
  removeThinking: (aiUserId: string) => void;
  /** Open the approval dialog for a specific approval id. */
  openApproval: (approvalId: string) => void;
  /** Close the approval dialog and clear its target. */
  closeApproval: () => void;
  /** Open the mobile sidebar drawer. */
  openMobileSidebar: () => void;
  /** Close the mobile sidebar drawer. */
  closeMobileSidebar: () => void;
  /** Toggle the mobile sidebar drawer. */
  toggleMobileSidebar: () => void;
}

export type WorkspaceStore = WorkspaceState & WorkspaceActions;

const initialState: WorkspaceState = {
  currentChannelId: null,
  thinkingAIs: new Set<string>(),
  approvalDialog: { open: false, approvalId: null },
  isMobileSidebarOpen: false,
};

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  ...initialState,

  setCurrentChannel: (channelId) =>
    set(() => ({
      currentChannelId: channelId,
      // Switching channels on mobile should auto-dismiss the drawer so
      // the user lands on the new channel's content immediately.
      isMobileSidebarOpen: false,
    })),

  addThinking: (aiUserId) =>
    set((state) => {
      if (state.thinkingAIs.has(aiUserId)) return state;
      const next = new Set(state.thinkingAIs);
      next.add(aiUserId);
      return { thinkingAIs: next };
    }),

  removeThinking: (aiUserId) =>
    set((state) => {
      if (!state.thinkingAIs.has(aiUserId)) return state;
      const next = new Set(state.thinkingAIs);
      next.delete(aiUserId);
      return { thinkingAIs: next };
    }),

  openApproval: (approvalId) =>
    set(() => ({ approvalDialog: { open: true, approvalId } })),

  closeApproval: () =>
    set(() => ({ approvalDialog: { open: false, approvalId: null } })),

  openMobileSidebar: () => set(() => ({ isMobileSidebarOpen: true })),
  closeMobileSidebar: () => set(() => ({ isMobileSidebarOpen: false })),
  toggleMobileSidebar: () =>
    set((state) => ({ isMobileSidebarOpen: !state.isMobileSidebarOpen })),
}));
