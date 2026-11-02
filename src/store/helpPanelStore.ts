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
import { isSameAssistantRun, type AgentDirectorySubject } from "@shared/types/agentDirectory";
import type { WindowGlobalAssistantPanel } from "@shared/types/ipc/help";
import { legacyHelpPanelAgentId } from "./persistence/agentDefaultsLegacy";
import { agentDefaultsClient } from "@/clients/agentDefaultsClient";
import { logError } from "@/utils/logger";
import { getAssistantSupportedAgentIds } from "../../shared/config/agentRegistry";
import { isBuiltInAgentId, isRetiredAgentId } from "../../shared/config/agentIds";
import {
  DEFAULT_ASSISTANT_SLOT,
  MAX_ASSISTANT_SLOTS,
  assistantSlotKey,
  isValidAssistantSlot,
} from "../../shared/config/assistantSlots";

function isAssistantSupportedAgentId(value: unknown): value is string {
  return typeof value === "string" && getAssistantSupportedAgentIds().includes(value);
}

/** What this view knows about the CLIs on the host it's attached to. */
export interface AssistantAgentAvailability {
  /** False until a real probe lands; before that no agent counts as uninstalled. */
  hasRealData: boolean;
  isInstalled: (agentId: string) => boolean;
}

/**
 * The agent this view can launch for the host's choice, and the choice it
 * can't use. The host's value is never rewritten here: the CLI may be
 * installed later, and a dropped choice is explained rather than forgotten.
 */
export function resolveAssistantAgent(
  hostAgentId: string | null,
  availability: AssistantAgentAvailability | null
): { preferredAgentId: string | null; unavailableAgentId: string | null } {
  if (!hostAgentId) return { preferredAgentId: null, unavailableAgentId: null };
  if (!isAssistantSupportedAgentId(hostAgentId)) {
    // A built-in demoted from tier:"stable" is a drop worth explaining. A
    // user-defined agent may only be waiting on its registry, which loads after
    // boot, so it's held back without a banner until it resolves.
    return {
      preferredAgentId: null,
      unavailableAgentId: isBuiltInAgentId(hostAgentId) ? hostAgentId : null,
    };
  }
  if (
    availability?.hasRealData &&
    isBuiltInAgentId(hostAgentId) &&
    !availability.isInstalled(hostAgentId)
  ) {
    return { preferredAgentId: null, unavailableAgentId: hostAgentId };
  }
  return { preferredAgentId: hostAgentId, unavailableAgentId: null };
}

/**
 * A person's pick in Settings, waiting to be applied to the live session in
 * this view. Kept apart from the default itself (#13345): the default is the
 * host's and changes under every window at once on an import or a pick
 * elsewhere, but only the view where someone chose should replace a session.
 */
export interface AgentSwitchRequest {
  id: number;
  agentId: string;
}

let agentSwitchRequestSeq = 0;
let assistantAgentWriteEpoch = 0;
// The host's last word on the assistant agent and the availability it was last
// resolved against, so a failed save falls back to what the host holds — not
// to an earlier optimistic pick that never landed either.
let acknowledgedAssistantAgentId: string | null = null;
let lastAssistantAvailability: AssistantAgentAvailability | null = null;

function resolvedAssistantPatch(
  state: Pick<HelpPanelState, "dismissedDroppedAgentId">,
  hostAgentId: string | null,
  availability: AssistantAgentAvailability | null
): Pick<HelpPanelState, "hostAssistantAgentId" | "preferredAgentId" | "droppedPreferredAgentId"> {
  const { preferredAgentId, unavailableAgentId } = resolveAssistantAgent(hostAgentId, availability);
  return {
    hostAssistantAgentId: hostAgentId,
    preferredAgentId,
    droppedPreferredAgentId:
      unavailableAgentId !== null && unavailableAgentId !== state.dismissedDroppedAgentId
        ? unavailableAgentId
        : null,
  };
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
  /**
   * An unhandled `[image #N]` activation for the rail to act on — reveal the
   * thumbnail, and open the lightbox when `open` is set. Separate from
   * `activeFigureNumber` because re-activating the figure that is already
   * current still has to scroll it back into view. The rail clears it once
   * handled, so a lane switch can't replay it.
   */
  figureRequest?: HelpFigureRequest;
}

export interface HelpFigureRequest {
  figureNumber: number;
  open: boolean;
  seq: number;
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
  /**
   * The assistant agent this view launches: the host's choice when it's
   * usable here, otherwise null. Derived from `hostAssistantAgentId` and
   * never persisted to this machine (#13345).
   */
  preferredAgentId: string | null;
  /** The host's assistant agent as stored there (`helpAssistant.agentId`). */
  hostAssistantAgentId: string | null;
  agentSwitchRequest: AgentSwitchRequest | null;
  /**
   * User consent to auto-launch a billed agent session when the panel opens.
   * Defaults to false so opening the panel never starts (and bills) a session
   * without an explicit user action (#10699). Only the panel menu's "Start when
   * the panel opens" item sets it, either way: starting one session is not
   * consent to every later open starting another (#14976).
   */
  autoLaunchEnabled: boolean;
  /**
   * The host's assistant agent when this view can't use it — demoted from
   * tier:"stable", or its CLI isn't installed on the host. Transient (never
   * persisted) — drives a one-shot banner so the null preference is explained
   * instead of leaving a blank empty state.
   */
  droppedPreferredAgentId: string | null;
  /** A dropped agent the banner was dismissed for, so a re-sync can't bring it back. */
  dismissedDroppedAgentId: string | null;
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
  /**
   * The `focusRequest` dictation made (#15870), or null when the latest was
   * anyone else's: the composer takes the keyboard whatever home says, with
   * its caret where the words go.
   */
  dictationFocusRequest: number | null;
  /**
   * The panel body shows the installation's global assistant instead of a
   * project lane (#14454). `activeSlot` keeps the lane to come back to.
   */
  globalSelected: boolean;
  /**
   * The exact global run "Open in Assistant" chose, or null to show whichever
   * runs. A chosen run that ended is said to have ended; its successor is
   * never shown in its place.
   */
  globalTarget: AgentDirectorySubject | null;
  /**
   * The latest `focusRequest` the global pane must treat as already served,
   * or -1. Global brought back by a project switch (#16099) wasn't asked for,
   * so the keyboard stays where the switch put it until a newer request.
   */
  globalFocusHandledThrough: number;
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
  /** Show the global assistant, pinned to one exact run or following whichever runs. */
  selectGlobal: (target?: AgentDirectorySubject | null) => void;
  /**
   * Take on the window's panel as the view it switched from left it (#16099).
   * Global showing there shows here, at once and without taking the keyboard;
   * Global closed there closes it here. A project lane is this project's own
   * and is never opened or closed by it, and nothing is ever launched.
   */
  applyWindowGlobalPanel: (panel: WindowGlobalAssistantPanel | null) => void;
  /**
   * A person choosing the assistant agent: shown at once, saved on the host,
   * and, unless `switchSession` is false, queued to replace this view's live
   * session (#8353).
   */
  setPreferredAgent: (agentId: string | null, options?: { switchSession?: boolean }) => void;
  /** Mirror the host's assistant agent. Never writes back, never switches a session. */
  syncHostAssistantAgent: (
    hostAgentId: string | null,
    availability: AssistantAgentAvailability | null
  ) => void;
  /** Re-resolve the current choice after the host's CLI availability changed. */
  refreshAssistantAvailability: (availability: AssistantAgentAvailability | null) => void;
  clearAgentSwitchRequest: (id: number) => void;
  setAutoLaunchEnabled: (enabled: boolean) => void;
  clearDroppedPreferredAgent: () => void;
  dismissIntro: () => void;
  markConversationStarted: (slot: number) => void;
  requestFocus: (options?: { forDictation?: boolean }) => void;
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
  /** Make a figure current and ask the rail to reveal it, or open it with `open`. */
  activateFigure: (slot: number, figureNumber: number, open: boolean) => void;
  /** The rail has acted on the lane's pending `figureRequest`. */
  clearFigureRequest: (slot: number) => void;
}

const initialState: HelpPanelState = {
  isOpen: false,
  width: HELP_PANEL_DEFAULT_WIDTH,
  sessions: { [DEFAULT_ASSISTANT_SLOT]: emptySlot() },
  activeSlot: DEFAULT_ASSISTANT_SLOT,
  preferredAgentId: null,
  hostAssistantAgentId: null,
  agentSwitchRequest: null,
  autoLaunchEnabled: false,
  droppedPreferredAgentId: null,
  dismissedDroppedAgentId: null,
  introDismissed: false,
  hibernateSessions: {},
  focusRequest: 0,
  dictationFocusRequest: null,
  globalSelected: false,
  globalTarget: null,
  globalFocusHandledThrough: -1,
};

/**
 * Apply `mutate` to one lane, leaving every sibling's object identity intact so
 * a lane's subscribers don't rerender when another lane moves. Returns the
 * state unchanged when the lane isn't open — a late callback from a lane the
 * user just closed must not resurrect it.
 */
// Monotonic across the store's lifetime rather than derived from the pending
// request: the rail clears a request once handled, and a count restarted from
// that cleared state would reissue a number the rail has already acted on.
let figureRequestSeq = 0;

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
    // Resume needs the same agent, and a retired one never launches again.
    if (isRetiredAgentId(agentId)) continue;
    out[key] = { sessionId, cwd, agentId };
  }
  return out;
}

type HelpPanelPersistedState = Pick<
  HelpPanelState,
  "width" | "autoLaunchEnabled" | "introDismissed" | "hibernateSessions"
>;

const HELP_PANEL_STORAGE_KEY = "help-panel-storage";

// Before v8 any Start click wrote `autoLaunchEnabled: true`, so a stored `true`
// from an older blob was never a choice to auto-start and reads as false
// wherever it turns up: hydration, a write merge, a sibling's storage event
// (#14976).
const AUTO_LAUNCH_CONSENT_SINCE_VERSION = 8;

const HELP_PANEL_PERSISTED_DEFAULTS: HelpPanelPersistedState = {
  width: HELP_PANEL_DEFAULT_WIDTH,
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
function toHelpPanelPersisted(
  state: Partial<HelpPanelState> | undefined,
  version: number | undefined
): HelpPanelPersistedState {
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
    autoLaunchEnabled:
      (version ?? 0) >= AUTO_LAUNCH_CONSENT_SINCE_VERSION && state.autoLaunchEnabled === true,
    introDismissed: state.introDismissed === true,
    hibernateSessions: sanitizeHibernateSessions(state.hibernateSessions),
  };
}

/**
 * The auto-launch choice in a raw stored blob, as a sibling view left it.
 * Undefined when the blob says nothing usable about it.
 */
function storedAutoLaunchEnabled(raw: string | null): boolean | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("state" in parsed)) return undefined;
  const { state } = parsed;
  if (typeof state !== "object" || state === null || !("autoLaunchEnabled" in state)) {
    return undefined;
  }
  const version = "version" in parsed && typeof parsed.version === "number" ? parsed.version : 0;
  if (version < AUTO_LAUNCH_CONSENT_SINCE_VERSION) return false;
  return typeof state.autoLaunchEnabled === "boolean" ? state.autoLaunchEnabled : undefined;
}

/**
 * Baseline-aware three-way merge for help-panel writes across project views
 * (issue #11351). Scalar preferences defer to a sibling's on-disk value unless
 * this writer changed them; `hibernateSessions` merges per project id so a stale
 * view neither drops a sibling's session nor resurrects one it (or a sibling)
 * intentionally cleared. Leaves the v5 hydration `merge` untouched.
 *
 * The pre-v7 `preferredAgentId` is carried forward from disk, and only from
 * disk, until a local window has moved it to the host and deleted it (#13345).
 * A remote-bound view writing first therefore can't erase this machine's
 * value before it migrates, and nothing in memory can put it back once gone.
 */
function mergeHelpPanelPersistedWrite({
  baseline,
  onDisk,
  incoming,
}: PersistWriteMergeContext<HelpPanelPersistedState>): StorageValue<HelpPanelPersistedState> {
  // No shared value on disk yet → nothing to reconcile against.
  if (!onDisk) return incoming;
  const base = baseline
    ? toHelpPanelPersisted(baseline.state, baseline.version)
    : HELP_PANEL_PERSISTED_DEFAULTS;
  const disk = toHelpPanelPersisted(onDisk.state, onDisk.version);
  const inc = toHelpPanelPersisted(incoming.state, incoming.version);
  const merged: HelpPanelPersistedState = {
    width: pickFieldByWriterDelta(base.width, inc.width, disk.width),
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
  const legacyAgentId = legacyHelpPanelAgentId(onDisk.state);
  return {
    version: incoming.version,
    state:
      legacyAgentId === undefined
        ? merged
        : ({ ...merged, preferredAgentId: legacyAgentId } as HelpPanelPersistedState),
  };
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
            // The preference is the host's and is never seeded from a launch
            // (#13345): a session that started on the sole installed agent
            // didn't choose a default for every window on the host. Overwriting
            // it here was also what made #8353's agent switch a no-op.
            // A launched session is a successful recovery — drop the stale
            // banner so it can't resurface if the panel later returns to the
            // empty state.
            droppedPreferredAgentId: null,
            dismissedDroppedAgentId: s.droppedPreferredAgentId ?? s.dismissedDroppedAgentId,
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
            figureRequest: undefined,
          }))
        ),

      openSlot: () => {
        let taken: number | null = null;
        set((s) => {
          for (let slot = 0; slot < MAX_ASSISTANT_SLOTS; slot += 1) {
            if (s.sessions[slot]) continue;
            taken = slot;
            return {
              sessions: { ...s.sessions, [slot]: emptySlot() },
              activeSlot: slot,
              globalSelected: false,
              globalTarget: null,
            };
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
          // Closing the lane on screen lands on its neighbour, the following one
          // first, as a browser tab strip does — and as the strip's keyboard
          // handoff already does for a background lane.
          const successor = remaining.find((n) => n > slot) ?? remaining[remaining.length - 1]!;
          return {
            sessions: next,
            activeSlot: s.activeSlot === slot ? successor : s.activeSlot,
          };
        }),

      setActiveSlot: (slot) =>
        set((s) =>
          s.sessions[slot] && (s.activeSlot !== slot || s.globalSelected)
            ? { activeSlot: slot, globalSelected: false, globalTarget: null }
            : s
        ),

      selectGlobal: (target = null) => set({ globalSelected: true, globalTarget: target }),

      applyWindowGlobalPanel: (panel) =>
        set((s) => {
          if (!panel) return s;
          if (!panel.showing) return s.isOpen && s.globalSelected ? { isOpen: false } : s;
          if (
            s.isOpen &&
            s.globalSelected &&
            (s.globalTarget === panel.target || isSameAssistantRun(s.globalTarget, panel.target))
          ) {
            return s;
          }
          // One update: an open panel on a project lane, even for a render, is
          // one that lane may auto-launch into.
          return {
            isOpen: true,
            globalSelected: true,
            globalTarget: panel.target,
            globalFocusHandledThrough: s.focusRequest,
          };
        }),

      setPreferredAgent: (agentId, options) => {
        const epoch = ++assistantAgentWriteEpoch;
        const switchSession = options?.switchSession !== false;
        set({
          hostAssistantAgentId: agentId,
          preferredAgentId: agentId,
          droppedPreferredAgentId: null,
          dismissedDroppedAgentId: null,
          agentSwitchRequest:
            switchSession && agentId ? { id: ++agentSwitchRequestSeq, agentId } : null,
        });
        void Promise.resolve()
          .then(() => agentDefaultsClient.set({ assistantAgentId: agentId }))
          .then((snapshot) => {
            if (epoch === assistantAgentWriteEpoch) {
              acknowledgedAssistantAgentId = snapshot?.assistantAgentId ?? null;
            }
          })
          .catch((error: unknown) => {
            logError("Failed to save the assistant agent", error);
            // Only the latest pick rolls back, and to what the host holds.
            if (epoch !== assistantAgentWriteEpoch) return;
            set((s) => ({
              ...resolvedAssistantPatch(s, acknowledgedAssistantAgentId, lastAssistantAvailability),
              agentSwitchRequest: null,
            }));
          });
      },

      syncHostAssistantAgent: (hostAgentId, availability) => {
        acknowledgedAssistantAgentId = hostAgentId;
        lastAssistantAvailability = availability;
        set((s) => {
          const next = resolvedAssistantPatch(s, hostAgentId, availability);
          return s.hostAssistantAgentId === next.hostAssistantAgentId &&
            s.preferredAgentId === next.preferredAgentId &&
            s.droppedPreferredAgentId === next.droppedPreferredAgentId
            ? s
            : next;
        });
      },

      refreshAssistantAvailability: (availability) => {
        lastAssistantAvailability = availability;
        set((s) => {
          const next = resolvedAssistantPatch(s, s.hostAssistantAgentId, availability);
          return s.preferredAgentId === next.preferredAgentId &&
            s.droppedPreferredAgentId === next.droppedPreferredAgentId
            ? s
            : next;
        });
      },

      clearAgentSwitchRequest: (id) =>
        set((s) => (s.agentSwitchRequest?.id === id ? { agentSwitchRequest: null } : s)),

      setAutoLaunchEnabled: (enabled) => set({ autoLaunchEnabled: enabled }),

      clearDroppedPreferredAgent: () =>
        set((s) => ({
          droppedPreferredAgentId: null,
          dismissedDroppedAgentId: s.droppedPreferredAgentId ?? s.dismissedDroppedAgentId,
        })),

      dismissIntro: () => set({ introDismissed: true }),

      markConversationStarted: (slot) =>
        set((s) =>
          patchSlot(s, slot, (entry) =>
            entry.conversationTouched ? entry : { ...entry, conversationTouched: true }
          )
        ),

      requestFocus: (options) =>
        set((s) => {
          const focusRequest = s.focusRequest + 1;
          return {
            focusRequest,
            dictationFocusRequest: options?.forDictation === true ? focusRequest : null,
          };
        }),

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
            // A new figure is the one the assistant is talking about now, so it
            // takes over as current from whatever an earlier reference picked.
            if (existing === -1) {
              return { ...entry, figures: [...entry.figures, figure], activeFigureNumber: null };
            }
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
            entry.figures.length === 0 &&
            entry.activeFigureNumber === null &&
            entry.figureRequest === undefined
              ? entry
              : { ...entry, figures: [], activeFigureNumber: null, figureRequest: undefined }
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

      activateFigure: (slot, figureNumber, open) =>
        set((s) =>
          patchSlot(s, slot, (entry) => ({
            ...entry,
            activeFigureNumber: figureNumber,
            figureRequest: { figureNumber, open, seq: ++figureRequestSeq },
          }))
        ),

      clearFigureRequest: (slot) =>
        set((s) =>
          patchSlot(s, slot, (entry) =>
            entry.figureRequest === undefined ? entry : { ...entry, figureRequest: undefined }
          )
        ),
    }),
    {
      name: HELP_PANEL_STORAGE_KEY,
      storage: createDebouncedSafeJSONStorage<HelpPanelPersistedState>(300, {
        mergeOnWrite: mergeHelpPanelPersistedWrite,
      }),
      // v6: `hibernateSessions` is keyed by `assistantSlotKey(projectId, slot)`
      // instead of bare projectId (#12108). The v5 → v6 key rewrite happens in
      // `sanitizeHibernateSessions`, which every read path already funnels
      // through, so no separate migration step can be skipped.
      // v7: `preferredAgentId` is the host's and no longer persisted here
      // (#13345). A v6 value stays on disk only until a local window moves it.
      // v8: a stored `autoLaunchEnabled` is dropped rather than kept as
      // consent (`AUTO_LAUNCH_CONSENT_SINCE_VERSION`, #14976).
      version: AUTO_LAUNCH_CONSENT_SINCE_VERSION,
      migrate: (persistedState, version) => {
        const migrated =
          version < AUTO_LAUNCH_CONSENT_SINCE_VERSION &&
          typeof persistedState === "object" &&
          persistedState !== null
            ? { ...persistedState, autoLaunchEnabled: false }
            : persistedState;
        return migrated as HelpPanelState & HelpPanelActions;
      },
      partialize: (state): HelpPanelPersistedState => ({
        width: state.width,
        autoLaunchEnabled: state.autoLaunchEnabled,
        introDismissed: state.introDismissed,
        hibernateSessions: state.hibernateSessions,
      }),
      merge: (persistedState: unknown, currentState) => {
        // A persisted `preferredAgentId` is ignored: the assistant agent comes
        // from the host (#13345), and a v6 value is only migration input.
        const persisted = persistedState as Partial<HelpPanelState>;
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
          // Default false for everyone, including returning users (v4 had no
          // such field) — the issue is surprise billing, so preserving the old
          // auto-launch for existing installs would preserve the reported bug.
          // A malformed (non-boolean) stored value normalizes to false too.
          autoLaunchEnabled: persisted.autoLaunchEnabled === true,
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
    "Pick<HelpPanelState, 'width' | 'autoLaunchEnabled' | 'introDismissed' | 'hibernateSessions'>",
});

// Turning auto-start off in one project view must reach every cached view at
// once, or switching to one of them would still start a billed session on
// open. Each view otherwise keeps the value it loaded until it reloads.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (event.key !== HELP_PANEL_STORAGE_KEY) return;
    // A sibling writing something else still carries the flag as disk had it,
    // and taking that would undo a change here that's still in its write
    // debounce. Only a write that moved the flag counts; a first write onto an
    // empty key moves it only if it isn't the default.
    const before =
      storedAutoLaunchEnabled(event.oldValue) ?? HELP_PANEL_PERSISTED_DEFAULTS.autoLaunchEnabled;
    const after =
      storedAutoLaunchEnabled(event.newValue) ?? HELP_PANEL_PERSISTED_DEFAULTS.autoLaunchEnabled;
    if (before === after) return;
    // What the store holds now, not what the event carried: events queue, and
    // an older one must not undo a newer change.
    let enabled: boolean | undefined;
    try {
      enabled = storedAutoLaunchEnabled(window.localStorage.getItem(HELP_PANEL_STORAGE_KEY));
    } catch {
      return;
    }
    if (enabled !== undefined && enabled !== useHelpPanelStore.getState().autoLaunchEnabled) {
      useHelpPanelStore.setState({ autoLaunchEnabled: enabled });
    }
  });
}

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
 * Whether a session can start without displacing one: a slot no tab holds yet,
 * or an open tab with nothing in it — no terminal, no session and no captured
 * conversation of `workspaceId`'s waiting to resume. Looser than the strip's
 * `+`, which only ever opens a new tab, because a session started on a named
 * agent fills an empty tab before it opens another (#13442).
 */
export function selectHasRoomForSession(
  state: HelpPanelState,
  workspaceId: string | null
): boolean {
  const open = selectOpenSlots(state);
  return (
    open.length < MAX_ASSISTANT_SLOTS ||
    open.some(
      (slot) =>
        !state.sessions[slot]?.terminalId &&
        !state.sessions[slot]?.sessionId &&
        !(workspaceId && assistantSlotKey(workspaceId, slot) in state.hibernateSessions)
    )
  );
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
