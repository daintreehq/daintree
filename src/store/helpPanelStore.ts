import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { StorageValue } from "zustand/middleware";
import { createDebouncedSafeJSONStorage } from "./persistence/safeStorage";
import {
  mergeRecordByWriterDelta,
  pickFieldByWriterDelta,
  type PersistWriteMergeContext,
} from "./persistence/persistWriteMerge";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";
import { getAssistantSupportedAgentIds } from "../../shared/config/agentRegistry";
import { isBuiltInAgentId } from "../../shared/config/agentIds";

function isAssistantSupportedAgentId(value: unknown): value is string {
  return typeof value === "string" && getAssistantSupportedAgentIds().includes(value);
}

export const HELP_PANEL_MIN_WIDTH = 320;
export const HELP_PANEL_MAX_WIDTH = 800;
export const HELP_PANEL_DEFAULT_WIDTH = 380;

export interface HelpHibernateSession {
  /**
   * Captured agent session ID (e.g. Claude resume token). Empty string is a
   * valid value and signals "capture failed — use the agent's resume-latest
   * fallback flag (e.g. `claude --continue`) on next open". See
   * `HelpSessionController._spawnResumed` for the falsy-sessionId branch.
   */
  sessionId: string;
  /** Working directory the resumed agent must launch from to find its transcript */
  cwd: string;
  /**
   * Agent that produced this session. Resume only fires when the next launch
   * targets the same agent — guards against agent switches between sleeps.
   */
  agentId: string;
}

/**
 * A documentation image the assistant surfaced via the `help.displayImage` MCP
 * tool (#9828). The main process validates the URL and assigns `figureNumber`
 * sequentially per session, so the model references it inline as `[image #N]`.
 */
export interface HelpFigure {
  imageId: string;
  figureNumber: number;
  figureLabel: string;
  url: string;
  caption?: string;
  altText?: string;
}

interface HelpPanelState {
  isOpen: boolean;
  width: number;
  terminalId: string | null;
  agentId: string | null;
  preferredAgentId: string | null;
  /**
   * User consent to auto-launch a billed agent session when the panel opens.
   * Defaults to false so opening the panel never starts (and bills) a session
   * without an explicit user action (#10699). The first-run "Start assistant"
   * CTA and starter-prompt chips flip this true, so subsequent opens resume the
   * auto-launch convenience the user has now opted into.
   */
  autoLaunchEnabled: boolean;
  /**
   * Set at rehydration when a persisted preferredAgentId was dropped because the
   * agent is no longer an assistant backend (CLI uninstalled or demoted from
   * tier:"stable"). Transient (never persisted) — drives a one-shot banner so
   * the silent null-out is explained instead of leaving a blank empty state.
   */
  droppedPreferredAgentId: string | null;
  sessionId: string | null;
  introDismissed: boolean;
  conversationTouched: boolean;
  /**
   * Per-project captured resume sessions, keyed by projectId. helpPanelStore
   * is shared across all project views (single localStorage partition), so
   * the assistant session for project A must not leak into project B.
   */
  hibernateSessions: Record<string, HelpHibernateSession>;
  /** Monotonic counter bumped by requestFocus() so repeated Cmd+L presses re-trigger the focus effect. */
  focusRequest: number;
  /**
   * Figures the assistant surfaced via `help.displayImage`, in arrival order
   * (#9828). Session-scoped and never persisted — a new conversation starts
   * empty, so stale image references can't survive an app restart.
   */
  figures: HelpFigure[];
  /**
   * The figure a clickable `[image #N]` reference last activated (#9830). The
   * figure rail (#9829) consumes this to scroll-to and highlight the matching
   * thumbnail. Session-scoped and never persisted — cleared on session reset.
   */
  activeFigureNumber: number | null;
}

interface HelpPanelActions {
  toggle: () => void;
  setOpen: (open: boolean) => void;
  setWidth: (width: number) => void;
  setTerminal: (terminalId: string, agentId: string, sessionId: string | null) => void;
  clearTerminal: () => void;
  setPreferredAgent: (agentId: string | null) => void;
  setAutoLaunchEnabled: (enabled: boolean) => void;
  clearDroppedPreferredAgent: () => void;
  dismissIntro: () => void;
  markConversationStarted: () => void;
  requestFocus: () => void;
  setHibernateSession: (
    projectId: string,
    entry: { sessionId: string; cwd: string; agentId: string }
  ) => void;
  clearHibernateSession: (projectId: string) => void;
  /** Append (or replace by imageId) a figure surfaced by `help.displayImage`. */
  addFigure: (figure: HelpFigure) => void;
  /** Drop all figures — called when the conversation/terminal resets. */
  clearFigures: () => void;
  /** Set the figure a clickable `[image #N]` reference activated (#9830). */
  setActiveFigureNumber: (figureNumber: number | null) => void;
}

const initialState: HelpPanelState = {
  isOpen: false,
  width: HELP_PANEL_DEFAULT_WIDTH,
  terminalId: null,
  agentId: null,
  preferredAgentId: null,
  autoLaunchEnabled: false,
  droppedPreferredAgentId: null,
  sessionId: null,
  introDismissed: false,
  conversationTouched: false,
  hibernateSessions: {},
  focusRequest: 0,
  figures: [],
  activeFigureNumber: null,
};

function isRecordOfUnknown(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function sanitizeHibernateSessions(value: unknown): Record<string, HelpHibernateSession> {
  if (!isRecordOfUnknown(value)) return {};
  const out: Record<string, HelpHibernateSession> = {};
  for (const [projectId, entry] of Object.entries(value)) {
    if (!projectId) continue;
    if (!isRecordOfUnknown(entry)) continue;
    const sessionId = entry.sessionId;
    const cwd = entry.cwd;
    const agentId = entry.agentId;
    // sessionId may be empty string — that's the "use resume-latest fallback"
    // sentinel persisted when graceful-shutdown capture missed (#8787).
    if (typeof sessionId !== "string") continue;
    if (typeof cwd !== "string" || !cwd) continue;
    if (typeof agentId !== "string" || !agentId) continue;
    out[projectId] = { sessionId, cwd, agentId };
  }
  return out;
}

type HelpPanelPersistedState = Pick<
  HelpPanelState,
  "width" | "preferredAgentId" | "autoLaunchEnabled" | "introDismissed" | "hibernateSessions"
>;

const HELP_PANEL_PERSISTED_DEFAULTS: HelpPanelPersistedState = {
  width: HELP_PANEL_DEFAULT_WIDTH,
  preferredAgentId: null,
  autoLaunchEnabled: false,
  introDismissed: false,
  hibernateSessions: {},
};

/**
 * Coerce a raw persisted blob (this view's baseline, disk, or incoming) to the
 * canonical persisted shape so the write merge compares like with like. A
 * missing/malformed field falls back to its default — the important case being
 * an absent baseline (a fresh view), which normalizes to the defaults so its
 * untouched fields compare equal to `incoming` and thus defer to a sibling's
 * on-disk value instead of clobbering it (issue #11351).
 */
function toHelpPanelPersisted(state: Partial<HelpPanelState> | undefined): HelpPanelPersistedState {
  if (!state) return HELP_PANEL_PERSISTED_DEFAULTS;
  return {
    width: typeof state.width === "number" ? state.width : HELP_PANEL_PERSISTED_DEFAULTS.width,
    preferredAgentId: typeof state.preferredAgentId === "string" ? state.preferredAgentId : null,
    autoLaunchEnabled: state.autoLaunchEnabled === true,
    introDismissed: state.introDismissed === true,
    hibernateSessions: sanitizeHibernateSessions(state.hibernateSessions),
  };
}

/**
 * Baseline-aware three-way merge for help-panel writes across project views
 * (issue #11351). Scalar preferences defer to a sibling's on-disk value unless
 * this writer changed them; `hibernateSessions` merges per project id so a stale
 * view neither drops a sibling's session nor resurrects one it (or a sibling)
 * intentionally cleared. Leaves the v5 hydration `merge` untouched.
 */
function mergeHelpPanelPersistedWrite({
  baseline,
  onDisk,
  incoming,
}: PersistWriteMergeContext<HelpPanelState & HelpPanelActions>): StorageValue<
  HelpPanelState & HelpPanelActions
> {
  // No shared value on disk yet → nothing to reconcile against.
  if (!onDisk) return incoming;
  const base = baseline ? toHelpPanelPersisted(baseline.state) : HELP_PANEL_PERSISTED_DEFAULTS;
  const disk = toHelpPanelPersisted(onDisk.state);
  const inc = toHelpPanelPersisted(incoming.state);
  const merged: HelpPanelPersistedState = {
    width: pickFieldByWriterDelta(base.width, inc.width, disk.width),
    preferredAgentId: pickFieldByWriterDelta(
      base.preferredAgentId,
      inc.preferredAgentId,
      disk.preferredAgentId
    ),
    autoLaunchEnabled: pickFieldByWriterDelta(
      base.autoLaunchEnabled,
      inc.autoLaunchEnabled,
      disk.autoLaunchEnabled
    ),
    introDismissed: pickFieldByWriterDelta(
      base.introDismissed,
      inc.introDismissed,
      disk.introDismissed
    ),
    hibernateSessions: mergeRecordByWriterDelta(
      base.hibernateSessions,
      inc.hibernateSessions,
      disk.hibernateSessions
    ),
  };
  return { version: incoming.version, state: { ...incoming.state, ...merged } };
}

export const useHelpPanelStore = create<HelpPanelState & HelpPanelActions>()(
  persist(
    (set) => ({
      ...initialState,

      toggle: () => set((s) => ({ isOpen: !s.isOpen })),

      setOpen: (open) => set({ isOpen: open }),

      setWidth: (width) =>
        set({
          width: Math.min(Math.max(width, HELP_PANEL_MIN_WIDTH), HELP_PANEL_MAX_WIDTH),
        }),

      setTerminal: (terminalId, agentId, sessionId) =>
        set((s) => ({
          terminalId,
          agentId,
          sessionId,
          // Only initialize the preference on first launch. An explicit user
          // choice (made via Settings) must survive terminal re-binds —
          // overwriting it here is what made #8353's agent switch a no-op.
          preferredAgentId: s.preferredAgentId ?? agentId,
          // A launched session is a successful recovery — drop the stale banner
          // so it can't resurface if the panel later returns to the empty state.
          droppedPreferredAgentId: null,
          conversationTouched: false,
        })),

      clearTerminal: () =>
        set({
          terminalId: null,
          agentId: null,
          sessionId: null,
          conversationTouched: false,
          // Figures are session-scoped — unbinding the terminal must drop them
          // (and any active highlight) so a relaunched session can't navigate
          // to a previous session's image (#9830).
          figures: [],
          activeFigureNumber: null,
        }),

      setPreferredAgent: (agentId) =>
        set({ preferredAgentId: agentId, droppedPreferredAgentId: null }),

      setAutoLaunchEnabled: (enabled) => set({ autoLaunchEnabled: enabled }),

      clearDroppedPreferredAgent: () => set({ droppedPreferredAgentId: null }),

      dismissIntro: () => set({ introDismissed: true }),

      markConversationStarted: () => set({ conversationTouched: true }),

      requestFocus: () => set((s) => ({ focusRequest: s.focusRequest + 1 })),

      setHibernateSession: (projectId, entry) =>
        set((s) => ({
          hibernateSessions: {
            ...s.hibernateSessions,
            [projectId]: { sessionId: entry.sessionId, cwd: entry.cwd, agentId: entry.agentId },
          },
        })),

      clearHibernateSession: (projectId) =>
        set((s) => {
          if (!(projectId in s.hibernateSessions)) return s;
          const next = { ...s.hibernateSessions };
          delete next[projectId];
          return { hibernateSessions: next };
        }),

      addFigure: (figure) =>
        set((s) => {
          const existing = s.figures.findIndex((f) => f.imageId === figure.imageId);
          if (existing === -1) {
            return { figures: [...s.figures, figure] };
          }
          // Idempotent upsert: a duplicate push (e.g. StrictMode double-mount
          // replaying the listener) replaces rather than appends.
          const next = s.figures.slice();
          next[existing] = figure;
          return { figures: next };
        }),

      clearFigures: () =>
        set((s) =>
          s.figures.length === 0 && s.activeFigureNumber === null
            ? s
            : { figures: [], activeFigureNumber: null }
        ),

      setActiveFigureNumber: (figureNumber) =>
        set((s) =>
          s.activeFigureNumber === figureNumber ? s : { activeFigureNumber: figureNumber }
        ),
    }),
    {
      name: "help-panel-storage",
      storage: createDebouncedSafeJSONStorage<HelpPanelState & HelpPanelActions>(300, {
        mergeOnWrite: mergeHelpPanelPersistedWrite,
      }),
      version: 5,
      migrate: (persistedState) => persistedState as HelpPanelState & HelpPanelActions,
      partialize: (state) => ({
        width: state.width,
        preferredAgentId: state.preferredAgentId,
        autoLaunchEnabled: state.autoLaunchEnabled,
        introDismissed: state.introDismissed,
        hibernateSessions: state.hibernateSessions,
      }),
      merge: (persistedState: unknown, currentState) => {
        const persisted = persistedState as Partial<HelpPanelState>;
        // Capture a built-in preference that's no longer a valid assistant
        // backend (demoted from tier:"stable") so the empty state can explain
        // the silent null-out instead of appearing blank. Restricted to built-in
        // IDs: the user agent registry loads asynchronously after this synchronous
        // rehydration, so a still-valid user-defined agent would otherwise be
        // false-flagged as dropped on every restart. A null/missing preference is
        // a clean first-run state, not a drop.
        const droppedPreferredAgentId =
          isBuiltInAgentId(persisted.preferredAgentId) &&
          !isAssistantSupportedAgentId(persisted.preferredAgentId)
            ? persisted.preferredAgentId
            : null;
        return {
          ...currentState,
          // The assistant can auto-launch as soon as it opens. Starting every
          // app boot hidden avoids launching from stale restart timing before
          // MCP readiness has settled.
          isOpen: false,
          width:
            typeof persisted.width === "number"
              ? Math.min(Math.max(persisted.width, HELP_PANEL_MIN_WIDTH), HELP_PANEL_MAX_WIDTH)
              : currentState.width,
          preferredAgentId: isAssistantSupportedAgentId(persisted.preferredAgentId)
            ? persisted.preferredAgentId
            : null,
          // Default false for everyone, including returning users (v4 had no
          // such field) — the issue is surprise billing, so preserving the old
          // auto-launch for existing installs would preserve the reported bug.
          // A malformed (non-boolean) stored value normalizes to false too.
          autoLaunchEnabled: persisted.autoLaunchEnabled === true,
          droppedPreferredAgentId,
          introDismissed:
            typeof persisted.introDismissed === "boolean"
              ? persisted.introDismissed
              : currentState.introDismissed,
          hibernateSessions: sanitizeHibernateSessions(persisted.hibernateSessions),
        };
      },
    }
  )
);

registerPersistedStore({
  storeId: "helpPanelStore",
  store: useHelpPanelStore,
  persistedStateType:
    "Pick<HelpPanelState, 'width' | 'preferredAgentId' | 'autoLaunchEnabled' | 'introDismissed' | 'hibernateSessions'>",
});
