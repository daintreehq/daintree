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
import {
  DEFAULT_ASSISTANT_SLOT,
  MAX_ASSISTANT_SLOTS,
  assistantSlotKey,
  isValidAssistantSlot,
} from "../../shared/config/assistantSlots";

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

/**
 * One assistant lane's live state (#12108). Everything here is per-session and
 * none of it is persisted — a lane's terminal, bearer and figures are all
 * meaningless across a restart, and the store instance is per project view
 * anyway. Only `hibernateSessions` outlives the view, and it is keyed by
 * `assistantSlotKey` so lanes can't overwrite each other.
 */
export interface HelpSessionSlotState {
  terminalId: string | null;
  agentId: string | null;
  sessionId: string | null;
  conversationTouched: boolean;
  /**
   * Figures the assistant surfaced via `help.displayImage`, in arrival order
   * (#9828). Per lane: a figure belongs to the conversation that produced it,
   * so a sibling lane must never be able to navigate to it.
   */
  figures: HelpFigure[];
  /** The figure a clickable `[image #N]` reference last activated (#9830). */
  activeFigureNumber: number | null;
}

function emptySlot(): HelpSessionSlotState {
  return {
    terminalId: null,
    agentId: null,
    sessionId: null,
    conversationTouched: false,
    figures: [],
    activeFigureNumber: null,
  };
}

interface HelpPanelState {
  isOpen: boolean;
  width: number;
  /**
   * Live assistant lanes, keyed by slot. Slot 0 always exists — the panel is
   * never session-less, it just shows an empty state. A lane appears when the
   * user adds a session and disappears when they close it.
   */
  sessions: Record<number, HelpSessionSlotState>;
  /** Which lane the panel body is showing. Always a key of `sessions`. */
  activeSlot: number;
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
  introDismissed: boolean;
  /**
   * Captured resume sessions, keyed by `assistantSlotKey(projectId, slot)`.
   * helpPanelStore is shared across all project views (single localStorage
   * partition), so the assistant session for project A must not leak into
   * project B — and since #12108, one lane's resume token must not overwrite
   * a sibling lane's either.
   */
  hibernateSessions: Record<string, HelpHibernateSession>;
  /** Monotonic counter bumped by requestFocus() so repeated Cmd+L presses re-trigger the focus effect. */
  focusRequest: number;
}

interface HelpPanelActions {
  toggle: () => void;
  setOpen: (open: boolean) => void;
  setWidth: (width: number) => void;
  setTerminal: (
    slot: number,
    terminalId: string,
    agentId: string,
    sessionId: string | null
  ) => void;
  clearTerminal: (slot: number) => void;
  /**
   * Add an empty lane and focus it. Returns the slot taken, or null when every
   * lane is occupied — the caller surfaces that rather than silently reusing
   * one, since reuse would displace a session the user never named.
   */
  openSlot: () => number | null;
  /**
   * Open one specific lane if it isn't already, leaving the active lane alone.
   *
   * The restore half of `openSlot`: a cold view knows only slot 0, so a lane
   * whose eviction-captured conversation survived on disk has to come back at
   * its ORIGINAL slot — the persisted entries are keyed by it — and recreating
   * a background tab must not yank the user off the lane they're looking at.
   */
  ensureSlot: (slot: number) => void;
  /** Drop a lane. Never removes the last one: the panel always has slot 0. */
  closeSlot: (slot: number) => void;
  setActiveSlot: (slot: number) => void;
  setPreferredAgent: (agentId: string | null) => void;
  setAutoLaunchEnabled: (enabled: boolean) => void;
  clearDroppedPreferredAgent: () => void;
  dismissIntro: () => void;
  markConversationStarted: (slot: number) => void;
  requestFocus: () => void;
  setHibernateSession: (
    projectId: string,
    slot: number,
    entry: { sessionId: string; cwd: string; agentId: string }
  ) => void;
  clearHibernateSession: (projectId: string, slot: number) => void;
  /** Append (or replace by imageId) a figure surfaced by `help.displayImage`. */
  addFigure: (slot: number, figure: HelpFigure) => void;
  /** Drop a lane's figures — called when its conversation/terminal resets. */
  clearFigures: (slot: number) => void;
  /** Set the figure a clickable `[image #N]` reference activated (#9830). */
  setActiveFigureNumber: (slot: number, figureNumber: number | null) => void;
}

const initialState: HelpPanelState = {
  isOpen: false,
  width: HELP_PANEL_DEFAULT_WIDTH,
  sessions: { [DEFAULT_ASSISTANT_SLOT]: emptySlot() },
  activeSlot: DEFAULT_ASSISTANT_SLOT,
  preferredAgentId: null,
  autoLaunchEnabled: false,
  droppedPreferredAgentId: null,
  introDismissed: false,
  hibernateSessions: {},
  focusRequest: 0,
};

/**
 * Apply `mutate` to one lane, leaving every sibling's object identity intact so
 * a lane's subscribers don't rerender when another lane moves. Returns the
 * state unchanged when the lane isn't open — a late callback from a lane the
 * user just closed must not resurrect it.
 */
function patchSlot(
  state: HelpPanelState,
  slot: number,
  mutate: (entry: HelpSessionSlotState) => HelpSessionSlotState
): Pick<HelpPanelState, "sessions"> | HelpPanelState {
  const existing = state.sessions[slot];
  if (!existing) return state;
  const next = mutate(existing);
  if (next === existing) return state;
  return { sessions: { ...state.sessions, [slot]: next } };
}

function isRecordOfUnknown(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/**
 * Normalize persisted hibernation keys AND migrate v5 keys in place.
 *
 * Before #12108 the key was a bare project id, which described the one lane
 * that existed then — slot 0. Doing the migration here rather than in a
 * `migrate` step matters: this same function canonicalizes the baseline, disk
 * and incoming blobs for the cross-view write merge, so a sibling view still
 * on a v5 blob and this view on a v6 one compare like with like instead of
 * accumulating one entry under each spelling (#11351).
 */
function sanitizeHibernateSessions(value: unknown): Record<string, HelpHibernateSession> {
  if (!isRecordOfUnknown(value)) return {};
  const out: Record<string, HelpHibernateSession> = {};
  for (const [rawKey, entry] of Object.entries(value)) {
    if (!rawKey) continue;
    const key = rawKey.includes("\u0000")
      ? rawKey
      : assistantSlotKey(rawKey, DEFAULT_ASSISTANT_SLOT);
    if (!isRecordOfUnknown(entry)) continue;
    const sessionId = entry.sessionId;
    const cwd = entry.cwd;
    const agentId = entry.agentId;
    // sessionId may be empty string — that's the "use resume-latest fallback"
    // sentinel persisted when graceful-shutdown capture missed (#8787).
    if (typeof sessionId !== "string") continue;
    if (typeof cwd !== "string" || !cwd) continue;
    if (typeof agentId !== "string" || !agentId) continue;
    out[key] = { sessionId, cwd, agentId };
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
    // Clamp width exactly as the v5 hydration `merge` does, so a raw baseline
    // holding an out-of-range value (legacy/hand-edited blob) canonicalizes to
    // the same clamped value the store hydrated into memory — otherwise the
    // clamp would read as a writer edit and clobber a sibling's width (#11351).
    width:
      typeof state.width === "number"
        ? Math.min(Math.max(state.width, HELP_PANEL_MIN_WIDTH), HELP_PANEL_MAX_WIDTH)
        : HELP_PANEL_PERSISTED_DEFAULTS.width,
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
 *
 * `preferredAgentId` is compared against the raw baseline, which is correct for
 * built-in assistant agents (validated synchronously at hydration, so baseline
 * and in-memory agree). The narrow residual: a user/plugin agent invalidated at
 * hydration only because its registry had not loaded yet can, across two
 * simultaneously-open views, converge to a null preference — recoverable by
 * re-selecting it, and no worse than the pre-fix full-replace clobber.
 */
function mergeHelpPanelPersistedWrite({
  baseline,
  onDisk,
  incoming,
}: PersistWriteMergeContext<HelpPanelPersistedState>): StorageValue<HelpPanelPersistedState> {
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
  return { version: incoming.version, state: merged };
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

      setTerminal: (slot, terminalId, agentId, sessionId) =>
        set((s) => {
          // A lane the user closed mid-launch must not come back: bind only
          // into a lane that is still open.
          if (!s.sessions[slot]) return s;
          return {
            sessions: {
              ...s.sessions,
              [slot]: {
                ...s.sessions[slot],
                terminalId,
                agentId,
                sessionId,
                conversationTouched: false,
              },
            },
            // Only initialize the preference on first launch. An explicit user
            // choice (made via Settings) must survive terminal re-binds —
            // overwriting it here is what made #8353's agent switch a no-op.
            preferredAgentId: s.preferredAgentId ?? agentId,
            // A launched session is a successful recovery — drop the stale
            // banner so it can't resurface if the panel later returns to the
            // empty state.
            droppedPreferredAgentId: null,
          };
        }),

      clearTerminal: (slot) =>
        set((s) =>
          patchSlot(s, slot, (entry) => ({
            ...entry,
            terminalId: null,
            agentId: null,
            sessionId: null,
            conversationTouched: false,
            // Figures are session-scoped — unbinding the terminal must drop
            // them (and any active highlight) so a relaunched session can't
            // navigate to a previous session's image (#9830).
            figures: [],
            activeFigureNumber: null,
          }))
        ),

      openSlot: () => {
        let taken: number | null = null;
        set((s) => {
          for (let slot = 0; slot < MAX_ASSISTANT_SLOTS; slot += 1) {
            if (s.sessions[slot]) continue;
            taken = slot;
            return { sessions: { ...s.sessions, [slot]: emptySlot() }, activeSlot: slot };
          }
          return s;
        });
        return taken;
      },

      ensureSlot: (slot) =>
        set((s) =>
          isValidAssistantSlot(slot) && !s.sessions[slot]
            ? { sessions: { ...s.sessions, [slot]: emptySlot() } }
            : s
        ),

      closeSlot: (slot) =>
        set((s) => {
          if (!s.sessions[slot]) return s;
          const remaining = Object.keys(s.sessions)
            .map(Number)
            .filter((n) => n !== slot)
            .sort((a, b) => a - b);
          // The panel is never lane-less. Closing the only lane resets it to an
          // empty slot 0 instead, which is what "close this session" means when
          // there is nothing to fall back to.
          if (remaining.length === 0) {
            return {
              sessions: { [DEFAULT_ASSISTANT_SLOT]: emptySlot() },
              activeSlot: DEFAULT_ASSISTANT_SLOT,
            };
          }
          const next = { ...s.sessions };
          delete next[slot];
          return {
            sessions: next,
            activeSlot: s.activeSlot === slot ? remaining[0]! : s.activeSlot,
          };
        }),

      setActiveSlot: (slot) =>
        set((s) => (s.sessions[slot] && s.activeSlot !== slot ? { activeSlot: slot } : s)),

      setPreferredAgent: (agentId) =>
        set({ preferredAgentId: agentId, droppedPreferredAgentId: null }),

      setAutoLaunchEnabled: (enabled) => set({ autoLaunchEnabled: enabled }),

      clearDroppedPreferredAgent: () => set({ droppedPreferredAgentId: null }),

      dismissIntro: () => set({ introDismissed: true }),

      markConversationStarted: (slot) =>
        set((s) =>
          patchSlot(s, slot, (entry) =>
            entry.conversationTouched ? entry : { ...entry, conversationTouched: true }
          )
        ),

      requestFocus: () => set((s) => ({ focusRequest: s.focusRequest + 1 })),

      setHibernateSession: (projectId, slot, entry) =>
        set((s) => ({
          hibernateSessions: {
            ...s.hibernateSessions,
            [assistantSlotKey(projectId, slot)]: {
              sessionId: entry.sessionId,
              cwd: entry.cwd,
              agentId: entry.agentId,
            },
          },
        })),

      clearHibernateSession: (projectId, slot) =>
        set((s) => {
          const key = assistantSlotKey(projectId, slot);
          if (!(key in s.hibernateSessions)) return s;
          const next = { ...s.hibernateSessions };
          delete next[key];
          return { hibernateSessions: next };
        }),

      addFigure: (slot, figure) =>
        set((s) =>
          patchSlot(s, slot, (entry) => {
            const existing = entry.figures.findIndex((f) => f.imageId === figure.imageId);
            if (existing === -1) return { ...entry, figures: [...entry.figures, figure] };
            // Idempotent upsert: a duplicate push (e.g. StrictMode double-mount
            // replaying the listener) replaces rather than appends.
            const figures = entry.figures.slice();
            figures[existing] = figure;
            return { ...entry, figures };
          })
        ),

      clearFigures: (slot) =>
        set((s) =>
          patchSlot(s, slot, (entry) =>
            entry.figures.length === 0 && entry.activeFigureNumber === null
              ? entry
              : { ...entry, figures: [], activeFigureNumber: null }
          )
        ),

      setActiveFigureNumber: (slot, figureNumber) =>
        set((s) =>
          patchSlot(s, slot, (entry) =>
            entry.activeFigureNumber === figureNumber
              ? entry
              : { ...entry, activeFigureNumber: figureNumber }
          )
        ),
    }),
    {
      name: "help-panel-storage",
      storage: createDebouncedSafeJSONStorage<HelpPanelPersistedState>(300, {
        mergeOnWrite: mergeHelpPanelPersistedWrite,
      }),
      // v6: `hibernateSessions` is keyed by `assistantSlotKey(projectId, slot)`
      // instead of bare projectId (#12108). The v5 → v6 key rewrite happens in
      // `sanitizeHibernateSessions`, which every read path already funnels
      // through, so no separate migration step can be skipped.
      version: 6,
      migrate: (persistedState) => persistedState as HelpPanelState & HelpPanelActions,
      partialize: (state): HelpPanelPersistedState => ({
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

// Frozen module singleton so the "closed lane" answer keeps a stable identity
// across reads — a fresh object each call would defeat every `useShallow` and
// `useSyncExternalStore` equality check that consumes it.
const EMPTY_SLOT: HelpSessionSlotState = Object.freeze({
  terminalId: null,
  agentId: null,
  sessionId: null,
  conversationTouched: false,
  figures: [] as HelpFigure[],
  activeFigureNumber: null,
});

/** Lanes currently open, ascending — the order the tab strip renders in. */
export function selectOpenSlots(state: HelpPanelState): number[] {
  return Object.keys(state.sessions)
    .map(Number)
    .filter(isValidAssistantSlot)
    .sort((a, b) => a - b);
}

/**
 * A lane's live state, or an empty one when the lane is closed.
 *
 * Never returns undefined so callers don't have to branch on a lane that was
 * closed between render and read; an empty lane and a missing one look the
 * same to the UI, which is correct — neither has a session.
 */
export function selectSlot(state: HelpPanelState, slot: number): HelpSessionSlotState {
  return state.sessions[slot] ?? EMPTY_SLOT;
}

/**
 * The lane the panel is currently showing — what a panel-level caller means by
 * "the assistant". Correct for anything the user directs at the surface they
 * are looking at: dictation, "send to assistant", the focus grab.
 */
export function selectActiveSlot(state: HelpPanelState): HelpSessionSlotState {
  return selectSlot(state, state.activeSlot);
}

/**
 * Which lane owns `terminalId`, or null when no lane does.
 *
 * Terminal-first rather than lane-first because the callers that need it —
 * xterm addons, per-terminal services — are handed a terminal and must find
 * the conversation it belongs to.
 */
export function selectSlotForTerminal(state: HelpPanelState, terminalId: string): number | null {
  for (const slot of selectOpenSlots(state)) {
    if (state.sessions[slot]?.terminalId === terminalId) return slot;
  }
  return null;
}

/**
 * Every live lane's terminal id.
 *
 * The right primitive for infrastructure that has to cover all sessions rather
 * than the focused one — dock filtering, wake-on-reveal, resize suppression.
 * Using the active lane there would leave background assistants out of the
 * very bookkeeping that keeps their terminals painting correctly.
 */
export function selectSlotTerminalIds(state: HelpPanelState): string[] {
  const ids: string[] = [];
  for (const slot of selectOpenSlots(state)) {
    const terminalId = state.sessions[slot]?.terminalId;
    if (terminalId) ids.push(terminalId);
  }
  return ids;
}
