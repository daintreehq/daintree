// Encapsulates the renderer-side session lifecycle that previously lived
// inline in HelpPanel.tsx: auto-launch, version probe, MCP provisioning,
// resume-or-fresh, idle hibernate with busy-recheck, gracefulKill, revoke,
// and tier-mismatch handling. The panel subscribes via `useSyncExternalStore`
// and delegates store writes back through the existing `helpPanelStore`
// actions — this controller never shadows persisted state.

import { getAgentConfig } from "@/config/agents";
import { actionService } from "@/services/ActionService";
import { useHelpPanelStore, selectSlot, selectOpenSlots } from "@/store/helpPanelStore";
import {
  DEFAULT_ASSISTANT_SLOT,
  assistantSlotKey,
  projectIdFromSlotKey,
} from "@shared/config/assistantSlots";
import { usePanelStore } from "@/store";
import { logError } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import type { ActionContext } from "@shared/types/actions";
import { buildResumeCommand, buildResumeLatestCommand } from "@shared/types/agentSettings";
import { isAssistantOnlyAgentId } from "@shared/config/agentIds";
import {
  type HelpSessionRef,
  provisionHelpSession,
  provisionFailureKind,
  buildHelpEnv,
  revokeHelpSession,
  asStringRecord,
} from "./HelpSessionProvisioner";
import { HelpVersionGate, checkAssistantVersion } from "./HelpVersionGate";
import {
  LaunchNotifications,
  notifyLaunchFailed,
  LAUNCH_BLOCKED_LOADING,
  LAUNCH_BLOCKED_NO_WORKSPACE,
} from "./LaunchNotifications";
import { McpActivityTracker } from "./McpActivityTracker";
import { HibernationManager } from "./HibernationManager";

export type HelpSessionPhase =
  "idle" | "version-checking" | "provisioning" | "launching" | "live" | "hibernating";

export interface VersionTooOld {
  agentId: string;
  agentName: string;
  installedVersion: string;
  requiredVersion: string;
}

/**
 * Outcome of `_spawnResumed` — pairs the spawned panel id with which resume
 * sub-kind actually ran. `"specific"` means we had a real session id and used
 * `buildResumeCommand`; `"latest"` means the hibernation entry carried the
 * empty-string sentinel and we fell through to the agent's `--continue`/
 * `resume --last` heuristic, whose result the renderer cannot verify (#10057).
 * The arm sites gate the "Resumed your previous session." banner on
 * `resumeKind === "specific"` to avoid falsely claiming a specific-session
 * restore when only the latest-conversation heuristic ran.
 */
export interface ResumeSpawnResult {
  panelId: string;
  resumeKind: "specific" | "latest";
}

export interface TierMismatchState {
  sessionId: string;
  toolId: string;
  tier: string;
  targetTier: "workbench" | "action" | "system" | null;
  /**
   * Captured at event time so "Always allow" persists to the project the
   * banner originated from, not whichever project is current at click time —
   * matters during rapid project switches.
   */
  projectId: string | null;
}

/**
 * Why a launch attempt failed, surfaced in the Help Panel as an inline banner
 * (the lower-restriction recovery surface) when the panel is open, instead of
 * a generic action-free toast. `kind` drives the banner's recovery copy — the
 * same discriminant pattern as `TierMismatchState.targetTier`. No raw error
 * text rides along: user-facing copy is keyed off `kind` so it stays free of
 * "MCP" / "token" / "bearer" jargon.
 */
export type LaunchErrorKind =
  | "mcp-server-not-started"
  | "mcp-probe-failed"
  | "skills-sync-failed"
  | "spawn-failed"
  | "folder-unavailable";

export interface LaunchErrorState {
  agentId: string;
  kind: LaunchErrorKind;
}

/**
 * A help-session the abuse policy revoked after the denial threshold was
 * exceeded (#10017). Surfaced as an inline error banner so the user learns
 * why the session stopped responding and can start a fresh one — without this
 * the session dies silently. `denialKind` records what tripped the policy
 * (`"auth401"`, `"tierMismatch"`, …) for diagnostics; the banner copy stays
 * jargon-free.
 */
export interface SessionRevokedState {
  sessionId: string;
  denialKind: string;
}

/**
 * Live MCP tool-call activity for the Assistant panel's ambient activity strip
 * (#9759). One row at a time: an in-flight call (tool id + args + elapsed) that
 * settles to a dimmed glyph + duration. Bursts within the same turn coalesce to
 * `callCount` ("N calls · latest tool"). `null` when no call has happened yet
 * (the strip is absent). An errored settle persists until the next call starts.
 */
export interface McpToolActivityState {
  /** "in-flight" while the call runs; "settled" once it resolves. */
  status: "in-flight" | "settled";
  /** The latest tool in the (possibly coalesced) burst. */
  toolId: string;
  /** Redacted single-line args summary for the latest call. */
  argsSummary: string;
  /** Epoch ms the latest call started — drives the elapsed timer. */
  startedAt: number;
  /** True when the latest in-flight call is a `danger: "confirm"` dispatch awaiting the user. */
  danger: boolean;
  /** Number of calls coalesced within the current turn (1 for a single call). */
  callCount: number;
  /**
   * Calls in the coalesced burst that have started but not yet settled. The
   * row only transitions to "settled" when this reaches zero — an early
   * settle from call A must not mark the row settled while call B still runs.
   */
  pendingCalls: number;
  /** Turn the burst is coalesced under; absent for calls outside a turn boundary. */
  turnId?: string;
  /** Settled wall-clock duration in ms. Absent while in-flight. */
  durationMs?: number;
  /** Audit-aligned result class. Absent while in-flight. */
  result?: import("@shared/types/ipc/mcpServer").McpAuditResult;
  /** Audit-aligned severity. Absent while in-flight. */
  severity?: import("@shared/types/ipc/mcpServer").McpAuditSeverity;
  /** True when the settled outcome is an error/critical severity (red tint, persists). */
  isError: boolean;
}

/**
 * The live per-`(sessionId, toolId)` grant minted by "Approve once" (#10042).
 * Drives the ambient countdown banner in the Help Panel. `expiresAt` is the
 * absolute epoch-ms the grant would lapse without further use — the renderer
 * counts down against it without polling (the `issueGrant` result and the
 * `grant.issued` lifecycle event both carry it). Single-slot: the most
 * recently issued grant is the one shown.
 */
export interface ActiveGrantState {
  sessionId: string;
  toolId: string;
  expiresAt: number;
  ttlMs: number;
}

/**
 * How a watched grant ended, for the brief "approval ended" notice (#10042).
 * Only the two reasons the user can act on are surfaced:
 * - `expired`: the sliding TTL lapsed with no recent use.
 * - `grant-ceiling`: the 30-minute hard ceiling tripped mid-use.
 * A user-initiated revoke and session teardown/idle clear the banner silently
 * — there's nothing for the user to do, and the session is already gone.
 */
export type GrantEndReason = "expired" | "grant-ceiling";

export interface GrantEndedState {
  toolId: string;
  reason: GrantEndReason;
}

export interface HelpSessionSnapshot {
  phase: HelpSessionPhase;
  showResumeBanner: boolean;
  assistantVersionTooOld: VersionTooOld | null;
  tierMismatch: TierMismatchState | null;
  isApprovingTier: boolean;
  /**
   * True while a manual "Check again" version re-probe is in flight or its
   * 5s cooldown is still running. Disables the gate's secondary button to
   * prevent probe hammering.
   */
  isCheckingVersion: boolean;
  launchError: LaunchErrorState | null;
  /** Live MCP tool-call activity for the ambient strip (#9759); null when idle. */
  mcpActivity: McpToolActivityState | null;
  /** Set when the abuse policy revoked the active session (#10017); null otherwise. */
  sessionRevoked: SessionRevokedState | null;
  /** The live "Approve once" grant being counted down (#10042); null when none. */
  activeGrant: ActiveGrantState | null;
  /** Brief notice that the watched grant lapsed (#10042); null when none. */
  grantEnded: GrantEndedState | null;
  /** True while a user-initiated grant revoke is in flight (#10042). */
  isRevokingGrant: boolean;
  /**
   * Most recent alertable turn outcome (`agent-stuck` / `reasoning-loop`) for
   * the bound help session (#10018); null when none is pending. Drives the
   * footer's ambient outcome pip. Cleared on dismiss, on a fresh turn, or on
   * session teardown/replacement.
   */
  outcomeAlert: import("@shared/types/ipc/mcpServer").TurnOutcomeAlertClass | null;
}

/**
 * The workspace the assistant launches into — an opaque `{ id, path }` pair,
 * NOT necessarily a `Project` (#11068). A scratch workspace is a valid
 * assistant workspace: `ProjectViewManager` keys its WebContents map on the
 * scratch id exactly as it does a project id, so main's `ctx.projectId` is the
 * scratch id while a scratch is active, and provisioning/hibernation validate
 * the id as an opaque string rather than a projects-table key. Nothing
 * downstream of acquisition branches on which kind it is, so the flattened
 * shape is deliberate — the legacy `currentProject` field name is kept to avoid
 * a rename with no behavior change.
 */
export interface HelpProjectRef {
  id: string;
  path: string;
}

export interface HelpSessionInputs {
  isOpen: boolean;
  isReadyToLaunch: boolean;
  /** Active workspace (project OR scratch) — see `HelpProjectRef`. */
  currentProject: HelpProjectRef | null;
  terminalId: string | null;
  preferredAgentId: string | null;
  supportedInstalledAgentIds: readonly string[];
  /**
   * User consent to auto-launch a billed session when the panel opens (#10699).
   * False until the user explicitly starts the assistant once; auto-launch is
   * fully suppressed while false, so revealing the panel never bills a session.
   */
  autoLaunchEnabled: boolean;
  /** Bumped each time the panel becomes visible — re-evaluates auto-launch. */
  visibilityEpoch: number;
}

export interface HelpLaunchOptions {
  agentId: string;
  /** Optional prompt to seed the agent — when set, the resume path is skipped. */
  seedPrompt?: string;
  /**
   * Pre-reserved terminal id. When provided, the controller writes
   * `setTerminal(requestedId, agentId, null)` synchronously before the first
   * await so the dock filter (`#6951`) sees the reservation immediately.
   * Pass for "+ New session" and "Run anyway" paths.
   */
  requestedId?: string;
  /** For run-anyway: bypass missing-CLI guard. */
  force?: boolean;
  /** For new-session / run-anyway: ask the dispatcher to activate the dock. */
  activateDock?: boolean;
  /** Remove the existing terminal+session before launching the new one. */
  replaceExisting?: boolean;
  /** True when called from the controller's auto-launch decision path. */
  isAutoLaunch?: boolean;
  /**
   * True when this auto-launch was initiated for the user's explicitly
   * preferred agent (not the sole-installed-agent fallback). Enables the
   * stale-agent guards that silently abandon — and re-evaluate — the launch
   * if `preferredAgentId` changes out from under it mid-flight (version probe
   * or dispatch). The single-installed-agent path leaves this false so a
   * preference set mid-launch never aborts it.
   */
  preferredAgentLaunch?: boolean;
  /**
   * Resume-only intent (cold switch-back / cross-window auto-resume, #10815).
   * The launch must restore a captured session or do nothing — it must NEVER
   * fall through to a fresh `agent.launch`. If the resume block finds no pending
   * entry (already taken, agentId mismatch, or another window won the atomic
   * take), the flow aborts cleanly without spawning a blank session that would
   * displace a backend another window just resumed. Silent on the
   * nothing-to-resume case — no user-facing launch error.
   */
  resumeOnly?: boolean;
}

// Exported for unit coverage of the model/customArgs flag composition.
export async function loadCustomLaunchFlags(): Promise<string[]> {
  try {
    const settings = await window.electron.helpAssistant.getSettings();
    const flags: string[] = [];
    // The model picker injects `--model <id>` first so a `--model` typed into
    // custom args still wins (CLIs are last-flag-wins on repeated `--model`),
    // keeping custom args the advanced override.
    const modelId = settings.modelId?.trim();
    if (modelId) flags.push("--model", modelId);
    const raw = settings.customArgs?.trim();
    if (raw) flags.push(...raw.split(/\s+/).filter(Boolean));
    return flags;
  } catch (err) {
    logError("Failed to load helpAssistant launch flags", err);
    return [];
  }
}

const INITIAL_SNAPSHOT: HelpSessionSnapshot = Object.freeze({
  phase: "idle",
  showResumeBanner: false,
  assistantVersionTooOld: null,
  tierMismatch: null,
  isApprovingTier: false,
  isCheckingVersion: false,
  launchError: null,
  mcpActivity: null,
  sessionRevoked: null,
  activeGrant: null,
  grantEnded: null,
  isRevokingGrant: false,
  outcomeAlert: null,
});

/**
 * Owns the imperative help-session lifecycle. One instance per HelpPanel
 * mount, created via `useRef` null-guard. The panel reads `getSnapshot()`
 * via `useSyncExternalStore` and calls action methods from event handlers
 * and synchronizing effects.
 *
 * Idempotency contract:
 * - Constructor is pure (no IPC, no timers, no async).
 * - `start()` arms IPC subscriptions; `stop()` clears all timers and
 *   unsubscribes. `start()` is idempotent so StrictMode's double-mount cycle
 *   doesn't double-arm.
 * - `_launchGen` is a monotonic counter — every async checkpoint compares
 *   the captured `gen` against `_launchGen` and bails if superseded.
 * - `_pendingNewTerminalId` is written synchronously before any `await` so
 *   the dock filter race (#6951) closes immediately when the reservation
 *   is committed to the store.
 */
export class HelpSessionController {
  /**
   * The assistant lane this controller drives (#12108). One controller per
   * lane: each owns its own IPC subscriptions, launch state machine and
   * hibernation timer, and reads/writes only its own slice of the store.
   *
   * Defaults to slot 0 so pre-lane callers and fixtures keep working.
   */
  readonly slot: number;

  constructor(slot: number = DEFAULT_ASSISTANT_SLOT) {
    this.slot = slot;
  }

  /** This lane's live state — never the panel's, never a sibling's. */
  private _slotState() {
    return selectSlot(useHelpPanelStore.getState(), this.slot);
  }

  private _snapshot: HelpSessionSnapshot = INITIAL_SNAPSHOT;
  private _listeners = new Set<() => void>();
  private _started = false;
  private _launchGen = 0;
  private _isLaunching = false;
  // Generation of the launch() that currently owns `_isLaunching`. The flow
  // releases the guard only when it still owns this token, so a stale unwind
  // can't drop a newer launch's guard, and a non-launch() supersession (the
  // auto-launch path bumping the gen) still lets the owner release.
  private _isLaunchingGen = -1;
  private _hasAutoLaunched = false;
  private _pendingSessionId: string | null = null;
  private _pendingNewTerminalId: string | null = null;
  /**
   * Dead-man timer for an in-flight launch. The launch FSM resets its loading
   * phase in a `finally` that only runs once the awaited IPCs settle — so a
   * never-settling bridge call (e.g. a hung CLI version probe) would otherwise
   * strand the panel on "Checking version…"/"Provisioning…" indefinitely. If a
   * launch hasn't reached a terminal state within `LAUNCH_WATCHDOG_MS`, this
   * supersedes it and surfaces a retryable error instead of an infinite
   * skeleton. The ceiling is generous (provision+launch legitimately runs
   * 6–45s) so it only fires on a genuine stall.
   */
  private _launchWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly LAUNCH_WATCHDOG_MS = 90_000;
  private _lastInputs: HelpSessionInputs | null = null;

  private readonly _versionGate = new HelpVersionGate({
    getSnapshot: () => this._snapshot,
    patch: (partial) => this._patch(partial),
    getLastInputs: () => this._lastInputs,
    setHasAutoLaunched: (value) => {
      this._hasAutoLaunched = value;
    },
    maybeAutoLaunch: (inputs) => this._maybeAutoLaunch(inputs),
  });

  private readonly _launchNotifications = new LaunchNotifications({
    patch: (partial) => this._patch(partial),
    isPanelOpen: () => this._lastInputs?.isOpen === true,
  });

  private readonly _mcpTracker = new McpActivityTracker({
    getSnapshot: () => this._snapshot,
    patch: (partial) => this._patch(partial),
    // This lane's session, so every MCP push is matched against the
    // conversation this controller owns rather than the focused one.
    getSessionId: () => this._slotState().sessionId,
    getSlot: () => this.slot,
  });

  private readonly _hibernationManager = new HibernationManager({
    getSnapshot: () => this._snapshot,
    patch: (partial) => this._patch(partial),
    resetPhase: () => this._resetPhase(),
    isLaunchCurrent: (gen) => gen === this._launchGen,
    getSlot: () => this.slot,
    getSlotState: () => this._slotState(),
  });

  // Bound for stable references across StrictMode re-subscribe.
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  getSnapshot = (): HelpSessionSnapshot => this._snapshot;

  /**
   * Arm IPC subscriptions. Idempotent across StrictMode double-mount: a
   * second start while `_started` is true is a no-op so we don't stack
   * tier-mismatch listeners.
   */
  start(): void {
    if (this._started) return;
    this._started = true;

    this._mcpTracker.start();
    this._hibernationManager.start();
  }

  stop(): void {
    if (!this._started) return;
    this._started = false;
    this._mcpTracker.dispose();
    this._hibernationManager.dispose();
    this._launchNotifications.dispose();
    this._versionGate.clearCooldownTimer();
    this._clearLaunchWatchdog();
    // Release the re-entrancy guard on teardown so a same-instance start() after
    // a never-settled launch (StrictMode remount) isn't permanently blocked.
    this._isLaunching = false;
    // Bumping the gen invalidates any in-flight launch so its post-await
    // checkpoints bail. Live store state is left intact so a StrictMode
    // synthetic unmount doesn't tear down the user's session; explicit
    // teardown happens through user-driven paths (`newSession`,
    // `replaceExisting`) or main-side eviction.
    this._launchGen++;
    this._lastInputs = null;
  }

  /**
   * Called from a single React effect whose deps cover every input the
   * controller needs. Each call may trigger:
   *  - clearing the version block when `preferredAgentId` changes;
   *  - arming or clearing the idle-hibernate timer;
   *  - the auto-launch decision (preferred or single-supported).
   */
  syncInputs(inputs: HelpSessionInputs): void {
    const prev = this._lastInputs;
    this._lastInputs = inputs;

    // Clear the version block when the preferred agent changes — the stale
    // block belongs to the previous agent and would otherwise paint over
    // the new agent's empty state. The launch-error banner is cleared for the
    // same reason: its `agentId` (and Retry target) belongs to the old agent.
    // The in-flight launch's stale-agent post-dispatch check handles its own
    // cleanup, so we don't bump `_launchGen` here.
    if (prev && prev.preferredAgentId !== inputs.preferredAgentId) {
      // Drop any in-flight "Check again" cooldown too — it belongs to the
      // previous agent's gate; leaving it would disable the new gate's
      // button until the stale probe settles.
      this._versionGate.clearCooldownTimer();
      this._patch({
        assistantVersionTooOld: null,
        isCheckingVersion: false,
        launchError: null,
      });
    }

    // Reset auto-launch guard when the panel closes so the next open can
    // try again from scratch.
    if (!inputs.isOpen) {
      this._hasAutoLaunched = false;
    }

    this._hibernationManager.maybeArm(inputs);
    this._maybeAutoLaunch(inputs);
  }

  /**
   * Revoke the bound help session if the underlying PTY panel disappears
   * from the panel store. addPanel puts the placeholder in panelsById
   * before setTerminal records the id here, so a missing entry usually
   * means the process exited — except during the brief window where the
   * +New session / Run-anyway flows have reserved the id but addPanel has
   * not yet committed it (guarded by `_pendingNewTerminalId`).
   */
  handleTerminalPanelMissing(args: { terminalId: string; terminalExists: boolean }): void {
    const { terminalId, terminalExists } = args;
    if (!terminalId || terminalExists) return;
    if (terminalId === this._pendingNewTerminalId) return;
    if (this._slotState().terminalId !== terminalId) return;

    // A controlled hibernate (`_fireHibernate`) can tear this same terminal
    // down while its `gracefulKill` is in flight — the PTY `onExit` removes the
    // `removeOnExit` panel out from under it. That flow owns the hibernate slot
    // and phase reset, so keep the legacy minimal cleanup and let it finish:
    // never clear hibernate, close the panel, or suppress relaunch here.
    const hibernating = this._snapshot.phase === "hibernating";

    revokeHelpSession(this._slotState().sessionId);
    useHelpPanelStore.getState().clearTerminal(this.slot);
    // The bound session is gone — drop any lingering activity row so the strip
    // doesn't show stale tool calls for a dead session (#9759), clear the
    // grant countdown/notice so they don't outlive the session (#10042), and
    // clear any pending outcome pip (#10018) so it can't bleed into the next
    // session.
    this._mcpTracker.clearActivity();
    this._mcpTracker.clearGrantState();
    this._mcpTracker.clearOutcomeAlert();

    if (hibernating) {
      this._hasAutoLaunched = false;
      return;
    }

    // The bound assistant PTY exited on its own — the user typed `/exit`, the
    // agent quit, or it crashed. Treat that as a real stop (like the Stop
    // button): make it stick so a consented auto-launch can't respawn it, then
    // slide the sidebar out. The user ended the session from inside the
    // terminal, so hide the panel rather than lingering on the empty state —
    // unless another lane is still open behind the tab strip.
    this._applyStopSuppression();
    this._closePanelUnlessSiblingLane();
  }

  /**
   * Recover a launch stranded by a project switch-back (#10739). Each project
   * runs in its own `WebContentsView`; switching away parks it in the LRU cache,
   * where Chromium throttles/freezes timers and microtasks. A launch caught
   * mid-flight leaves the FSM in a loading phase, but the dead-man watchdog
   * (`_armLaunchWatchdog`) is a `setTimeout` that doesn't fire while parked, so
   * it can't reap the stall — and auto-launch is short-circuited while hidden,
   * so switching *back* never re-drives it. The loading skeleton then sticks
   * forever. We key off the same explicit `app:view-revealed` main-process
   * signal `useClearSwitchBusyStateOnReveal` uses (a bare DOM `visibilitychange`
   * is unreliable for a cached-view reveal).
   *
   * On reveal, silently reap a stuck loading-phase launch exactly as the
   * watchdog would — minus `_surfaceLaunchError`, since we re-drive immediately
   * and the user should see recovery, not a failure — then re-evaluate
   * auto-launch. The empty-state launch resumes the hibernated session via the
   * resume command, so this reconnects and re-drives the existing session
   * rather than starting a fresh one.
   *
   * `hibernating` is excluded: that phase owns a live terminal with a graceful
   * shutdown in flight, not a stuck loader. A non-null bound `terminalId` is
   * also excluded — a live terminal (or a synchronously-reserved `newSession`/
   * `runAnyway` slot) is not a stranded auto-launch and must not be reaped.
   */
  handleViewRevealed(): void {
    const phase = this._snapshot.phase;
    const isStuckLaunch = phase !== "idle" && phase !== "live" && phase !== "hibernating";
    // Only reap the AUTO-launch path. A manual `selectAgent()` launch doesn't set
    // `_hasAutoLaunched`, and the re-drive below can't restart it (`_maybeAutoLaunch`
    // short-circuits on `!autoLaunchEnabled`), so reaping it would silently discard
    // the user's explicit pick. Leaving it alone lets its own watchdog reap it (with
    // a retryable error) once the view un-parks, or the thawed IPC complete it.
    if (isStuckLaunch && this._hasAutoLaunched && (this._lastInputs?.terminalId ?? null) === null) {
      // Supersede the stranded flow so its in-flight awaits bail at their next
      // gen-check (`_abandonInFlightLaunch`); clear the re-entrancy guard so the
      // re-drive below isn't dropped; revoke the minted-but-orphaned bearer; and
      // drop the phase to idle so the loading skeleton clears.
      this._launchGen++;
      this._isLaunching = false;
      this._hasAutoLaunched = false;
      this._clearLaunchWatchdog();
      this._revokePendingSession();
      this._resetPhase();
    }
    // Re-drive: auto-launch short-circuits while hidden, so a launch interrupted
    // by the switch is never restarted on return. Now that the view is the
    // foreground again, re-evaluate from the last synced inputs. `_maybeAutoLaunch`
    // guards on `document.hidden`/`isOpen`/`terminalId`/`_hasAutoLaunched`, so a
    // live or already-bound session is a no-op.
    const inputs = this._lastInputs;
    if (inputs) this._maybeAutoLaunch({ ...inputs });
  }

  /**
   * User-initiated launch from the empty-state agent picker or other
   * caller. Mirrors the original `handleSelectAgent` semantics: removes the
   * existing terminal if present, runs the version gate, provisions, then
   * either resumes or starts fresh.
   */
  selectAgent(agentId: string, seedPrompt?: string): void {
    this.launch({ agentId, seedPrompt, replaceExisting: true });
  }

  /**
   * "+ New session" — destructive reset: stop the current agent, drop the
   * conversation, revoke the bound + pending sessions, then relaunch the
   * same agent. The reserved id is pre-recorded in the store synchronously
   * so the dock filter sees the new reservation the instant `addPanel`
   * commits (#6951).
   */
  newSession(): void {
    const { terminalId, agentId } = this._slotState();
    if (!terminalId || !agentId) return;
    const reservedId = `terminal-${crypto.randomUUID()}`;
    this.launch({
      agentId,
      requestedId: reservedId,
      replaceExisting: true,
      activateDock: true,
    });
  }

  /**
   * User-facing "Stop assistant" — actually end the running assistant terminal
   * rather than merely hiding the panel (`handleClose` only flips `isOpen`,
   * leaving the agent running). Unlike `newSession()` this does NOT relaunch:
   * it tears the bound session down and slides the sidebar out (#11833) rather
   * than lingering on the empty state, matching the agent self-exit and PTY-exit
   * paths once their identity/hibernation guards pass. (The replacing flows —
   * `newSession`, `runAnyway`, agent switch — also tear down, but keep the panel
   * open because they immediately launch again.) Stop discards the conversation
   * instead of pausing it, which is why the UI gates it behind a confirm
   * whenever there is live work or an engaged conversation to lose; reopening
   * starts fresh through the normal launch / auto-launch flow. Safe to call
   * repeatedly: with nothing bound it skips the teardown but still invalidates
   * any in-flight launch and closes, converging on the same stopped state.
   *
   * The slide-out only ever happens when this is the LAST open lane (#12108).
   * That guard lives in `_closePanelUnlessSiblingLane` rather than at each
   * caller, because every stop path used to make its own call and most of them
   * made it wrong: Stop, the agent's own `/exit`, and a PTY exit all slid the
   * whole sidebar out while a second session was still running behind the tab
   * strip, taking a live conversation off screen with it. Only the tab's own
   * close control had the check. For the last lane the close is load-bearing,
   * not cosmetic: `closeSlot` recreates an empty slot 0 whose fresh controller
   * has never auto-launched, and `_maybeAutoLaunch` hard-gates on `isOpen`.
   *
   * `closePanel: false` opts out of the slide-out entirely, for callers that
   * know they are about to launch again into the same panel.
   */
  endSession(options: { closePanel?: boolean } = {}): void {
    this._stopBoundSession(options.closePanel ?? true);
  }

  /**
   * The bound assistant's agent CLI exited from inside its own terminal — the
   * user typed `/exit`, or the agent quit — surfaced as `agentState: "exited"`.
   * Most assistant agents run inside a shell, so the agent exiting does NOT
   * exit the PTY (`handleTerminalPanelMissing` never fires and the sidebar
   * would otherwise linger on a dead shell). Once the hibernation and
   * current-terminal guards below pass, reuse the Stop button's teardown and
   * slide-out. No confirmation — the exit already happened.
   *
   * Guards keep a stale or racing signal from tearing down the wrong session:
   * skip while a hibernate owns the teardown, and only act when `terminalId`
   * is still the currently-bound one (a `+New session`/replace may have already
   * moved on). The caller debounces on a settled "exited" so a transient
   * mis-detection flap (#10911) that bounces back via `respawn` can't kill a
   * live session.
   */
  handleAgentExited(terminalId: string): void {
    if (this._snapshot.phase === "hibernating") return;
    if (this._slotState().terminalId !== terminalId) return;
    this._stopBoundSession(true);
  }

  /**
   * Shared stop core for the Stop button (`endSession`) and the terminal
   * self-exit (`handleAgentExited`). Aborts any in-flight launch first (mirrors
   * `cancelLaunch`) so a late-settling provision can't bind a fresh terminal
   * after the stop, tears the bound session down (revoke-before-kill), makes
   * the stop stick, then slides the sidebar out. Both callers end the session
   * outright, so neither leaves the panel behind on its empty state — except
   * when `closePanel` is false because another lane is still live (#12108).
   */
  private _stopBoundSession(closePanel: boolean): void {
    this._launchGen++;
    this._isLaunching = false;
    this._clearLaunchWatchdog();

    const { terminalId: existingTerminalId, sessionId: previousSessionId } = this._slotState();
    if (existingTerminalId) {
      this._teardownBoundSession(existingTerminalId, previousSessionId, {
        revokePending: true,
      });
    } else {
      // No committed terminal, but a reserved-but-uncommitted session may still
      // hold a live bearer — drop it so it can't outlive the stop.
      this._revokePendingSession();
    }

    this._applyStopSuppression();

    if (closePanel) this._closePanelUnlessSiblingLane();
  }

  /**
   * Slide the sidebar out — but only if no OTHER lane is open.
   *
   * "Open" is a slot that exists in the store, not one with a live terminal: a
   * tab the user has opened and not yet launched into is still a tab they are
   * looking at, and hiding the panel would take it away. This is the same
   * predicate the tab strip's own close uses (`selectOpenSlots(state).length`),
   * kept here so every stop path shares one answer. The lane being stopped is
   * still in the store at this point — `closeSlot` runs after the stop — which
   * is why it is excluded by slot rather than by counting.
   */
  private _closePanelUnlessSiblingLane(): void {
    const store = useHelpPanelStore.getState();
    const siblingOpen = selectOpenSlots(store).some((slot) => slot !== this.slot);
    if (!siblingOpen) store.setOpen(false);
  }

  /**
   * Shared "make the stop stick" tail, run once the bound session's PTY +
   * bearer are already gone. Stop is destructive (not pause): drop the
   * persisted hibernate entry for this project so the just-ended conversation
   * can't resume on next open, disarm any pending hibernate timer, consume this
   * open cycle's auto-launch budget so a consented auto-launch
   * (`_maybeAutoLaunch`) can't immediately respawn the assistant that was just
   * stopped, then clear session-scoped banners and drop the phase to idle so
   * the panel lands on a clean empty / start state. Shared by
   * `_stopBoundSession` (Stop button + agent self-exit) and the PTY-exit path
   * (`handleTerminalPanelMissing`).
   *
   * Closing the panel is what actually prevents the relaunch — every caller
   * closes, and `_maybeAutoLaunch` hard-gates on `isOpen`. The budget write is
   * a cheap belt on this shared tail, not the load-bearing guard: a pre-close
   * render snapshot can reach `syncInputs` late, but it carries that render's
   * still-bound `terminalId`, so the terminal gate already turns it away.
   * `syncInputs` clears the flag once the close is observed, leaving the next
   * open free to auto-launch.
   */
  private _applyStopSuppression(): void {
    // Read the workspace from the synced inputs, not the project store: in a
    // scratch workspace `currentProject` is null by design, and a live-store
    // read would leave the scratch's hibernate entry behind (#11068).
    const workspaceId = this._lastInputs?.currentProject?.id ?? null;
    this._hibernationManager.clearAndSuppress(workspaceId);
    this._hasAutoLaunched = true;
    this._patch({
      phase: "idle",
      showResumeBanner: false,
      tierMismatch: null,
      sessionRevoked: null,
    });
  }

  /**
   * "Run anyway" from the missing-CLI gate — same as `newSession` plus
   * `force: true` so the dispatcher bypasses the missing-CLI guard.
   */
  runAnyway(): void {
    const { terminalId, agentId } = this._slotState();
    if (!terminalId || !agentId) return;
    const reservedId = `terminal-${crypto.randomUUID()}`;
    this.launch({
      agentId,
      requestedId: reservedId,
      replaceExisting: true,
      activateDock: true,
      force: true,
    });
  }

  /**
   * Unified launch handler. The three legacy entry points (handleSelectAgent,
   * doNewSession, handleRunAnyway) collapse into this one method — options
   * model their differences.
   *
   * Synchronous write order before the first `await` (preserving #6951):
   *   1. Capture live state + bump _launchGen.
   *   2. If `replaceExisting`, revoke prior sessions then remove the panel.
   *   3. If `requestedId`, set `_pendingNewTerminalId` synchronously, then
   *      write the reservation via `setTerminal(reservedId, agentId, null)`.
   *   4. Only then enter the async provision/dispatch sequence.
   */
  launch(options: HelpLaunchOptions): void {
    const inputs = this._lastInputs;
    const launchAgentId = options.agentId;
    if (!inputs?.isReadyToLaunch || !inputs.currentProject) {
      // A resume-only auto-resume is silent best-effort recovery — the renderer
      // re-fires once state is ready (#10815), so dropping it here must not raise
      // a scary "still loading" error. Every other caller surfaces it.
      if (!options.resumeOnly) {
        // Only say "loading" when state really is still hydrating. Ready-but-no-
        // workspace is a different condition and used to lie about it (#11068).
        notifyLaunchFailed(
          launchAgentId,
          inputs?.isReadyToLaunch ? LAUNCH_BLOCKED_NO_WORKSPACE : LAUNCH_BLOCKED_LOADING
        );
      }
      return;
    }
    // Block only while a launch() that is STILL the current generation owns the
    // guard. If the owning launch was superseded (its generation is stale) but
    // never unwound — e.g. a hung IPC, or the preferred-agent auto-launch path
    // bumping the gen without owning `_isLaunching` — its orphaned guard must
    // not block every future launch. The watchdog reaps the phase; this keeps
    // the re-entrancy guard from outliving the flow that set it.
    if (this._isLaunching && this._isLaunchingGen === this._launchGen) return;

    const launchProject = inputs.currentProject;
    this._isLaunching = true;

    // A launch supersedes any revoked-session banner — the user is starting a
    // fresh session, so the prior session's revocation no longer applies (#10017).
    if (this._snapshot.sessionRevoked) this._patch({ sessionRevoked: null });

    // Snapshot the focused worktree/terminal synchronously before any await
    // so the session is pinned to what the user had focused at launch — the
    // HelpPanel footer chip surfaces this binding (#8772), and pinned tool
    // dispatch relies on the same snapshot (#8317).
    const launchContext = actionService.getContext();

    const gen = ++this._launchGen;
    // Tie the re-entrancy guard to this generation so only the launch() that
    // set it releases it (see `_executeLaunch`'s finally) — a flow superseded
    // by a newer launch() must not drop the newer guard.
    this._isLaunchingGen = gen;
    const replaceExisting = options.replaceExisting === true;
    const reservedId = options.requestedId ?? null;
    let presetEnv: Record<string, string> | undefined;

    if (replaceExisting) {
      const { terminalId: existingTerminalId, sessionId: previousSessionId } = this._slotState();
      if (existingTerminalId) {
        const panel = usePanelStore.getState().panelsById[existingTerminalId];
        presetEnv = asStringRecord(panel?.extensionState?.presetEnv);
        this._teardownBoundSession(existingTerminalId, previousSessionId, {
          revokePending: reservedId != null,
        });
      }
      // Discarding the current conversation invalidates any persisted
      // hibernate entry for this workspace — leaving it would resume the
      // just-discarded chat on next open. Use the workspace already captured
      // for this launch: in a scratch the project store is null by design, and
      // a live read would strand the scratch's entry (#11068).
      if (reservedId) {
        useHelpPanelStore.getState().clearHibernateSession(launchProject.id, this.slot);
        this._patch({ showResumeBanner: false });
      }
    }

    if (reservedId) {
      // Synchronous reservation — must complete before any `await` so the
      // dock filter (#6951) sees `helpPanelStore.terminalId === reservedId`
      // the instant `addPanel` commits.
      this._pendingNewTerminalId = reservedId;
      useHelpPanelStore.getState().setTerminal(this.slot, reservedId, launchAgentId, null);
    }

    safeFireAndForget(this._executeLaunch(gen, options, launchProject, presetEnv, launchContext), {
      context: reservedId
        ? options.force
          ? "Help: run-anyway re-launch"
          : "Help: + New session relaunch"
        : "Help: select agent launch",
    });
  }

  dismissResumeBanner(): void {
    this._launchNotifications.dismissResumeBanner();
  }

  dismissTierMismatch(): void {
    this._mcpTracker.dismissTierMismatch();
  }

  dismissLaunchError(): void {
    this._patch({ launchError: null });
  }

  dismissSessionRevoked(): void {
    this._mcpTracker.dismissSessionRevoked();
  }

  dismissGrantEnded(): void {
    this._mcpTracker.dismissGrantEnded();
  }

  revokeGrant(): void {
    this._mcpTracker.revokeGrant();
  }

  approveTierOnce(): void {
    this._mcpTracker.approveTierOnce();
  }

  alwaysAllowTier(): void {
    this._mcpTracker.alwaysAllowTier();
  }

  /**
   * Abort an in-flight launch from the loading-state Cancel affordance.
   * Bumps the launch generation so the in-flight async checkpoints bail at
   * their next gen-check (cleaning up via `_abandonInFlightLaunch`), clears
   * the reentrancy guard synchronously so a subsequent user-initiated launch
   * isn't silently dropped, and drops the phase back to idle so the panel
   * returns to its empty state immediately.
   */
  cancelLaunch(): void {
    this._launchGen++;
    this._isLaunching = false;
    this._clearLaunchWatchdog();
    this._resetPhase();
  }

  /**
   * Manual "Check again" from the version gate. Re-probes the installed CLI
   * version with `refresh=true` so a user who updated the CLI while the gate
   * was visible recovers without reopening the panel (the version probe is
   * otherwise cached for 12h). On a passing probe the gate clears and the
   * normal auto-launch flow resumes; on a still-too-old result the gate
   * refreshes with the latest versions. A 5s minimum cooldown keeps the
   * button disabled to prevent probe hammering.
   */
  checkVersionAgain(): void {
    this._versionGate.checkAgain();
  }

  // --- internal ---

  private _resetPhase(): void {
    this._patch({ phase: "idle" });
  }

  /**
   * Tear down the currently-bound help session's renderer state in the order
   * the auth race requires: revoke the session bearer BEFORE removing the PTY
   * so any in-flight MCP call 401s before teardown reaches the host (#7522);
   * drop the reserved-but-uncommitted bearer when asked; then clear the
   * store-side session UI (terminal slot, figures #9828, MCP activity #9759,
   * grant state #10042, outcome pip #10018). Shared by `launch({
   * replaceExisting })` and the user-facing `endSession()`. Callers own
   * presetEnv capture and hibernate cleanup.
   */
  private _teardownBoundSession(
    existingTerminalId: string,
    previousSessionId: string | null,
    options: { revokePending: boolean }
  ): void {
    // Revoke the bearer(s) BEFORE removing the panel: removePanel fires the PTY
    // kill IPC, so revoking first ensures any in-flight MCP call 401s before the
    // teardown reaches the host (#7522), rather than racing the kill.
    revokeHelpSession(previousSessionId);
    if (options.revokePending) this._revokePendingSession();
    usePanelStore.getState().removePanel(existingTerminalId);
    useHelpPanelStore.getState().clearTerminal(this.slot);
    useHelpPanelStore.getState().clearFigures(this.slot);
    this._mcpTracker.clearActivity();
    this._mcpTracker.clearGrantState();
    this._mcpTracker.clearOutcomeAlert();
  }

  /**
   * Arm the launch dead-man timer for generation `gen`. If the launch is still
   * in a loading phase when it fires, a bridge call has hung past the ceiling:
   * bump `_launchGen` so the stalled flow's later gen-checks bail, clear the
   * re-entrancy guards, reset the phase, and surface a retryable launch error.
   * A superseded or already-settled launch is a no-op.
   */
  private _armLaunchWatchdog(gen: number, agentId: string): void {
    this._clearLaunchWatchdog();
    this._launchWatchdogTimer = setTimeout(() => {
      this._launchWatchdogTimer = null;
      if (gen !== this._launchGen) return;
      const phase = this._snapshot.phase;
      if (phase === "idle" || phase === "live") return;
      // Supersede the stranded flow so its in-flight await resolves into a
      // gen-mismatch bail instead of patching stale state back in.
      this._launchGen++;
      this._hasAutoLaunched = false;
      this._isLaunching = false;
      // The gen-check above proves we still own `_pendingSessionId`, so a
      // post-provision hang doesn't strand the minted bearer. Revoke it
      // before resetting — otherwise the token outlives the launch forever.
      this._revokePendingSession();
      this._resetPhase();
      this._surfaceLaunchError(agentId, "spawn-failed");
    }, this.LAUNCH_WATCHDOG_MS);
  }

  private _clearLaunchWatchdog(): void {
    if (this._launchWatchdogTimer) {
      clearTimeout(this._launchWatchdogTimer);
      this._launchWatchdogTimer = null;
    }
  }

  /**
   * Route a launch failure to the least-restricted surface that conveys it.
   * When the panel is open, the failure becomes an inline banner the user can
   * retry from in place; when it's closed, we fall back to a toast so the
   * failure isn't lost. The MCP failure kinds keep the settings-routing toast
   * (a real recovery action); everything else uses the plain launch-failed
   * toast.
   */
  private _surfaceLaunchError(agentId: string, kind: LaunchErrorKind): void {
    this._launchNotifications.surfaceLaunchError(agentId, kind);
  }

  /** Dismiss the ambient outcome pip (#10018). User-driven click-to-clear. */
  dismissOutcomeAlert(): void {
    this._mcpTracker.dismissOutcomeAlert();
  }

  /** Clear the live activity strip (e.g. on session teardown). */
  clearMcpActivity(): void {
    this._mcpTracker.clearActivity();
  }

  private _patch(partial: Partial<HelpSessionSnapshot>): void {
    // Spread-merge first, then structurally compare per-field. Reusing the
    // same snapshot reference when nothing changed keeps Object.is stable
    // for useSyncExternalStore.
    const next: HelpSessionSnapshot = { ...this._snapshot, ...partial };
    if (
      next.phase === this._snapshot.phase &&
      next.showResumeBanner === this._snapshot.showResumeBanner &&
      next.assistantVersionTooOld === this._snapshot.assistantVersionTooOld &&
      next.tierMismatch === this._snapshot.tierMismatch &&
      next.isApprovingTier === this._snapshot.isApprovingTier &&
      next.isCheckingVersion === this._snapshot.isCheckingVersion &&
      next.launchError === this._snapshot.launchError &&
      next.mcpActivity === this._snapshot.mcpActivity &&
      next.sessionRevoked === this._snapshot.sessionRevoked &&
      next.activeGrant === this._snapshot.activeGrant &&
      next.grantEnded === this._snapshot.grantEnded &&
      next.isRevokingGrant === this._snapshot.isRevokingGrant &&
      next.outcomeAlert === this._snapshot.outcomeAlert
    ) {
      return;
    }
    this._snapshot = Object.freeze(next);
    for (const listener of this._listeners) {
      try {
        listener();
      } catch (err) {
        logError("HelpSessionController: listener threw", err);
      }
    }
  }

  private _revokePendingSession(): void {
    const pending = this._pendingSessionId;
    if (pending) {
      this._pendingSessionId = null;
      revokeHelpSession(pending);
    }
  }

  /**
   * Called from every stale-gen early return inside the async launch flow.
   * Cleans up the local synchronous reservation (reservedId paths) and
   * revokes the provisioned session token (provision-succeeded paths)
   * before the method exits, so neither a phantom `terminalId` nor a
   * minted-but-orphaned session token survives the abort. Removing a
   * spawned panel after a stale dispatch is the caller's responsibility
   * — it has the result in scope.
   */
  private _abandonInFlightLaunch(
    reservedId: string | null,
    session: HelpSessionRef | null,
    options: { resetAutoLaunch: boolean }
  ): void {
    if (reservedId) {
      // Clear the reservation only if the store still points at our slot.
      // Another launch may have already taken over and overwritten it.
      if (this._pendingNewTerminalId === reservedId) {
        this._pendingNewTerminalId = null;
        if (this._slotState().terminalId === reservedId) {
          useHelpPanelStore.getState().clearTerminal(this.slot);
        }
      }
    }
    if (session) {
      revokeHelpSession(session.sessionId);
      if (this._pendingSessionId === session.sessionId) {
        this._pendingSessionId = null;
      }
    }
    if (options.resetAutoLaunch) {
      this._hasAutoLaunched = false;
    }
  }

  private _maybeAutoLaunch(inputs: HelpSessionInputs): void {
    // Consent gate first (#10699): with no explicit opt-in, opening the panel
    // must never start a billed session. Placed ahead of the visibility check
    // so a visibilityEpoch re-arm can't bypass consent on a restore.
    if (!inputs.autoLaunchEnabled) return;
    if (typeof document !== "undefined" && document.hidden) return;
    if (!inputs.isOpen) return;
    if (!inputs.isReadyToLaunch) return;
    if (!inputs.currentProject) return;
    if (inputs.terminalId) return;
    if (this._hasAutoLaunched) return;

    if (inputs.preferredAgentId) {
      this._hasAutoLaunched = true;
      // Route through launch() like the sole-installed-agent path below, so the
      // re-entrancy guard (_isLaunching/_isLaunchingGen) and FSM live in one
      // place. `preferredAgentLaunch` arms the stale-agent guards that abandon
      // and re-evaluate if the preference changes mid-flight (#10703).
      this.launch({
        agentId: inputs.preferredAgentId,
        isAutoLaunch: true,
        preferredAgentLaunch: true,
        replaceExisting: true,
      });
      return;
    }

    if (inputs.supportedInstalledAgentIds.length === 1) {
      const onlyAgentId = inputs.supportedInstalledAgentIds[0];
      if (!onlyAgentId) return;
      this._hasAutoLaunched = true;
      this.launch({
        agentId: onlyAgentId,
        isAutoLaunch: true,
        replaceExisting: true,
      });
    }
  }

  private async _spawnResumed(
    launchAgentId: string,
    hibernated: { sessionId: string; cwd: string },
    session: HelpSessionRef | null,
    folderPath: string,
    launchProject: HelpProjectRef
  ): Promise<ResumeSpawnResult | null> {
    const customLaunchFlags = await loadCustomLaunchFlags();
    const flags = customLaunchFlags.length > 0 ? customLaunchFlags : undefined;
    const hasSpecificSessionId = hibernated.sessionId.length > 0;
    // "Resume the latest session in this cwd" is only meaningful when this lane
    // is the only one that has ever launched there. Every lane of a project now
    // shares one session directory, so with a sibling lane around, "latest" is
    // as likely to be THEIR conversation as this lane's — and resuming someone
    // else's transcript into this tab is worse than starting fresh. An explicit
    // id is always safe; the cwd-keyed fallback is gated on being alone.
    //
    // "Around" means open OR hibernated: a sibling that is closed but captured
    // left its transcript in the same cwd, and after a restart with only this
    // lane open it is exactly the one `--continue` would find first.
    const store = useHelpPanelStore.getState();
    const ownKey = assistantSlotKey(launchProject.id, this.slot);
    const hibernatedSibling = Object.keys(store.hibernateSessions).some(
      (key) => key !== ownKey && projectIdFromSlotKey(key) === launchProject.id
    );
    const soleLane =
      !hibernatedSibling && selectOpenSlots(store).every((slot) => slot === this.slot);

    // The Daintree Assistant runs in the project root (env-only MCP, ships its
    // own skills, reads nothing from cwd) — never the session dir or the
    // captured hibernation cwd. Other help agents resume in the session dir
    // that owns their config files.
    const cwd = isAssistantOnlyAgentId(launchAgentId)
      ? launchProject.path
      : (session?.sessionPath ?? hibernated.cwd ?? folderPath);

    // And "latest in this cwd" has to mean THIS cwd. An entry captured in a
    // different directory — a lane from before every lane shared one — would
    // have `--continue` pick up whatever conversation the shared directory saw
    // last, which is not the one the entry was for. A specific id is not bound
    // this way: the CLIs resolve it wherever the transcript lives.
    const sameCwd = !hibernated.cwd || hibernated.cwd === cwd;
    const latest = soleLane && sameCwd ? buildResumeLatestCommand(launchAgentId, flags) : undefined;
    const command = hasSpecificSessionId
      ? (buildResumeCommand(launchAgentId, hibernated.sessionId, flags) ?? latest)
      : latest;
    if (!command) return null;
    // Bind the resumed session's project identity to the project captured at
    // launch, not live store state — otherwise a project switch mid-resume
    // could make cwd (the captured project) and DAINTREE_PROJECT_ID disagree.
    // Mirrors the fresh-launch path, which passes `launchProject.id`.
    const env = buildHelpEnv(session, launchProject.id, launchAgentId);

    const newId = await usePanelStore.getState().addPanel({
      kind: "terminal",
      launchAgentId,
      command,
      cwd,
      location: "overlay",
      excludeFromPersistence: true,
      removeOnExit: true,
      ...(env && { env }),
      ...(customLaunchFlags.length > 0 && { agentLaunchFlags: customLaunchFlags }),
    });
    if (!newId) return null;
    // The empty `sessionId` sentinel flows from main's `revokeSession({ captureHibernation: true })`
    // race during LRU eviction (#10057) — we still attempt the spawn via the agent's
    // `--continue`/`-r latest`/`resume --last` heuristic, but the renderer cannot
    // verify whether that heuristic actually found a prior session, so the
    // "Resumed your previous session." banner is suppressed on this branch.
    const resumeKind: ResumeSpawnResult["resumeKind"] = hasSpecificSessionId
      ? "specific"
      : "latest";
    return { panelId: newId, resumeKind };
  }

  private async _executeLaunch(
    gen: number,
    options: HelpLaunchOptions,
    launchProject: HelpProjectRef,
    presetEnv: Record<string, string> | undefined,
    launchContext?: ActionContext
  ): Promise<void> {
    const launchAgentId = options.agentId;
    const reservedId = options.requestedId ?? null;
    const resetAutoLaunch = options.isAutoLaunch === true;
    let session: HelpSessionRef | null = null;
    // The finally drops the phase back to idle on a non-success exit that's
    // still the current generation, so the loading skeleton never sticks.
    let reached = false;
    // Set by the preferred-agent stale guard when the preference changed
    // mid-flight: the re-launch for the now-current agent must run AFTER the
    // finally releases `_isLaunching`, or launch()'s re-entrancy guard would
    // see this generation still holding it and silently drop the relaunch
    // (#10703) — leaving `_hasAutoLaunched` stuck and blocking all auto-launch.
    let pendingReEval: HelpSessionInputs | null = null;
    // The main-captured resume token this launch has taken but not yet used,
    // with the claim id that authorizes putting it back.
    // `takePendingHibernation` is destructive on main, so every abort
    // downstream of a successful take used to destroy the user's only resume
    // token — across five separate early returns plus any provisioning failure
    // or throw (#11477). One variable released from the `finally` covers them
    // all, including early returns added later. Cleared only where the token is
    // genuinely spent: a resumed session that survived its post-spawn checks.
    // `mirrored` records whether this take also reached the renderer's durable
    // `hibernateSessions` slot, so the release only drops that mirror when it
    // is genuinely ours — the bails below fire before it is ever written.
    let unreleasedHibernation: {
      projectId: string;
      claimId: string;
      mirrored: boolean;
    } | null = null;
    // Clear any prior failure banner up front so a retry immediately drops the
    // stale error while the new attempt is in flight.
    this._patch({ launchError: null });
    this._armLaunchWatchdog(gen, launchAgentId);
    try {
      // reservedId paths (newSession/runAnyway) skip the version gate, so they
      // open straight at "provisioning"; the empty-state flow starts at the
      // version probe.
      this._patch({ phase: reservedId ? "provisioning" : "version-checking" });
      const folderPath = await window.electron.help.getFolderPath();
      if (gen !== this._launchGen) {
        this._abandonInFlightLaunch(reservedId, session, { resetAutoLaunch });
        return;
      }

      // Empty-state launch (no reservedId) treats a null folder as a
      // hard fail. New-session and run-anyway already have a live
      // terminal context so the folder path isn't strictly required.
      if (!reservedId && !folderPath) {
        if (options.isAutoLaunch) this._hasAutoLaunched = false;
        this._surfaceLaunchError(launchAgentId, "folder-unavailable");
        return;
      }

      // Version gate runs BEFORE provisionHelpSession so we don't mint a
      // session token we'd immediately discard. Skipped for the
      // "requestedId" paths (newSession/runAnyway) because those are
      // triggered from a live terminal where the version was already
      // accepted on the initial launch.
      if (!reservedId) {
        const launchAgentName = getAgentConfig(launchAgentId)?.name ?? launchAgentId;
        const versionBlock = await checkAssistantVersion(
          launchAgentId,
          launchAgentName,
          this._versionGate.hasBlockedThisSession
        );
        if (gen !== this._launchGen) {
          this._abandonInFlightLaunch(reservedId, session, { resetAutoLaunch });
          return;
        }
        if (versionBlock) {
          // Stale-agent guard (preferred-agent auto-launch only): skip the
          // block if the user changed preferredAgentId while the probe was in
          // flight — the new agent's empty state shouldn't be covered by an
          // "Update X" message that no longer applies.
          if (
            options.preferredAgentLaunch === true &&
            useHelpPanelStore.getState().preferredAgentId !== launchAgentId
          ) {
            this._hasAutoLaunched = false;
            return;
          }
          this._hasAutoLaunched = false;
          this._versionGate.setHasBlockedThisSession(true);
          this._patch({ assistantVersionTooOld: versionBlock });
          return;
        }
        this._versionGate.setHasBlockedThisSession(false);
        this._patch({ assistantVersionTooOld: null, phase: "provisioning" });
      }

      // #10819: resume-only intent must claim the pending-hibernation entry
      // BEFORE provisioning. `provisionHelpSession` calls `displacePriorSessions`
      // in main, which revokes/kills the project's existing assistant backend. In
      // a multi-window cold-restore race, both windows would provision (and so
      // displace each other) before reaching the `resumeOnly` abort below, leaving
      // both with no live backend. The atomic `takePendingHibernation` is the
      // single-winner gate: a null take (lost the race, or nothing captured) or an
      // agentId mismatch aborts before any displacement. The seeded local-store
      // entry then drives the normal resume block; `_seedHibernateFromMain` is
      // skipped for this path since the take already happened.
      if (options.resumeOnly && !reservedId && !options.seedPrompt) {
        let earlyPending: {
          agentId: string;
          agentSessionId: string;
          cwd: string;
          claimId: string;
        } | null = null;
        try {
          earlyPending = await window.electron.help.takePendingHibernation(
            launchProject.id,
            this.slot
          );
        } catch (err) {
          logError("HelpPanel: resumeOnly early hibernation take failed", err);
        }
        // Main has already cleared its side, so from here on this launch owns
        // the token and the `finally` is what gives it back (#11477).
        if (earlyPending) {
          unreleasedHibernation = {
            projectId: launchProject.id,
            claimId: earlyPending.claimId,
            // Not seeded yet — the two bails below return before the store
            // write, and a release from there must not touch the slot.
            mirrored: false,
          };
        }
        if (gen !== this._launchGen) {
          this._abandonInFlightLaunch(reservedId, session, { resetAutoLaunch });
          return;
        }
        if (!earlyPending || earlyPending.agentId !== launchAgentId) {
          this._abandonInFlightLaunch(reservedId, session, { resetAutoLaunch });
          return;
        }
        useHelpPanelStore.getState().setHibernateSession(launchProject.id, this.slot, {
          sessionId: earlyPending.agentSessionId,
          cwd: earlyPending.cwd,
          agentId: earlyPending.agentId,
        });
        if (unreleasedHibernation) unreleasedHibernation.mirrored = true;
      }

      const outcome = await provisionHelpSession(
        launchProject,
        launchAgentId,
        launchContext,
        this.slot
      );
      if (gen !== this._launchGen) {
        if (outcome.ok) session = outcome.session;
        this._abandonInFlightLaunch(reservedId, session, { resetAutoLaunch });
        return;
      }
      if (!outcome.ok) {
        if (reservedId) {
          this._pendingNewTerminalId = null;
          useHelpPanelStore.getState().clearTerminal(this.slot);
        } else {
          this._hasAutoLaunched = false;
        }
        this._surfaceLaunchError(launchAgentId, provisionFailureKind(outcome.code));
        return;
      }
      session = outcome.session;
      if (!reservedId) {
        this._pendingSessionId = session.sessionId;
      }
      this._patch({ phase: "launching" });
      // The Daintree Assistant is env-only (MCP via DAINTREE_MCP_* env vars)
      // and ships its own skills, so it reads nothing from cwd. Run it in the
      // project root so its file tools and the terminal's file-link resolution
      // operate on the actual project; other help agents stay in the session
      // dir that owns their .mcp.json / settings. `launchProject` is the exact
      // project this session was provisioned for, so cwd can't drift to a
      // different project the user switched to mid-launch.
      const cwd = isAssistantOnlyAgentId(launchAgentId) ? launchProject.path : session.sessionPath;
      const helpEnv = buildHelpEnv(session, launchProject.id, launchAgentId);
      const env: Record<string, string> | undefined =
        helpEnv || presetEnv ? { ...(presetEnv ?? {}), ...(helpEnv ?? {}) } : undefined;

      // Resume path applies only to the empty-state select-agent flow.
      // newSession/runAnyway explicitly discard prior sessions.
      if (!reservedId && !options.seedPrompt) {
        // Seed hibernate from main's pending-hibernation store so an
        // eviction-captured entry is available to the lookup below. The
        // helper checks `gen` after its IPC await so a superseded launch
        // doesn't write a stale entry back into helpPanelStore.
        //
        // #10819: the `resumeOnly` path already performed the atomic
        // `takePendingHibernation` before provisioning and seeded the local
        // store from it, so re-seeding here is skipped — a second take would
        // return null (the entry is consumed) and clear nothing, but running it
        // is wasteful and misleading.
        if (!options.resumeOnly) {
          const seeded = await this._hibernationManager.seedFromMain(launchProject.id, gen);
          // "released" already handed it back inside seedFromMain (it saw the
          // stale gen first); only a live seed leaves this launch owning it.
          if (seeded.status === "seeded") {
            // "seeded" means the entry IS in the store, so the mirror is ours.
            unreleasedHibernation = {
              projectId: launchProject.id,
              claimId: seeded.claimId,
              mirrored: true,
            };
          }
          if (gen !== this._launchGen) {
            this._abandonInFlightLaunch(reservedId, session, { resetAutoLaunch });
            return;
          }
        }
        const hibernated =
          useHelpPanelStore.getState().hibernateSessions[
            assistantSlotKey(launchProject.id, this.slot)
          ];
        if (hibernated && hibernated.agentId === launchAgentId && folderPath) {
          const resumed = await this._spawnResumed(
            launchAgentId,
            hibernated,
            session,
            folderPath,
            launchProject
          );
          if (gen !== this._launchGen) {
            if (resumed) usePanelStore.getState().removePanel(resumed.panelId);
            this._abandonInFlightLaunch(reservedId, session, { resetAutoLaunch });
            return;
          }
          if (resumed) {
            const expectedSessionId = session.sessionId;
            if (this._pendingSessionId !== expectedSessionId) {
              usePanelStore.getState().removePanel(resumed.panelId);
              return;
            }
            // The token is now genuinely spent: the resumed session survived
            // both post-spawn checks and is about to go live. Every other exit
            // from here leaves the marker set so the `finally` gives it back.
            unreleasedHibernation = null;
            useHelpPanelStore.getState().clearHibernateSession(launchProject.id, this.slot);
            useHelpPanelStore
              .getState()
              .setTerminal(this.slot, resumed.panelId, launchAgentId, session.sessionId);
            this._pendingSessionId = null;
            window.electron.help.markTerminal(resumed.panelId).catch((err) => {
              logError("Failed to mark help terminal", err);
            });
            reached = true;
            this._patch({ phase: "live" });
            // Only claim a specific-session restore when we actually had a
            // specific session id — the latest-conversation heuristic
            // (`--continue` / `resume --last`) may or may not have found a
            // prior session, and the renderer cannot tell from outside.
            if (resumed.resumeKind === "specific") {
              this._patch({ showResumeBanner: true });
              this._launchNotifications.armResumeBannerAutoDismiss();
            }
            return;
          }
          useHelpPanelStore.getState().clearHibernateSession(launchProject.id, this.slot);
        }
      }

      // #10815: resume-only intent (cold switch-back / cross-window auto-resume).
      // The resume block above returns on a successful resume; reaching here means
      // there was nothing to resume — no captured entry, an agentId mismatch, a
      // missing folder, or another window won the atomic `takePendingHibernation`.
      // NEVER fall through to a fresh `agent.launch`: that would displace a backend
      // another window just resumed (single-backend invariant + HelpSessionService
      // revoke) or replace the user's conversation with a blank session. Release
      // the provisioned session and bail silently — the finally resets the phase,
      // and no `_surfaceLaunchError` fires (this is an expected no-op, not a
      // failure the user should see).
      if (options.resumeOnly) {
        this._abandonInFlightLaunch(reservedId, session, { resetAutoLaunch });
        return;
      }

      const customLaunchFlags = await loadCustomLaunchFlags();
      if (gen !== this._launchGen) {
        this._abandonInFlightLaunch(reservedId, session, { resetAutoLaunch });
        return;
      }

      const dispatchArgs: Record<string, unknown> = {
        agentId: launchAgentId,
        location: "overlay",
        cwd,
        excludeFromPersistence: true,
        removeOnExit: true,
      };
      if (env) dispatchArgs.env = env;
      if (customLaunchFlags.length > 0) dispatchArgs.agentLaunchFlags = customLaunchFlags;
      if (options.seedPrompt) dispatchArgs.prompt = options.seedPrompt;
      if (reservedId) dispatchArgs.requestedId = reservedId;
      if (options.activateDock) dispatchArgs.activateDockOnCreate = true;
      if (options.force) dispatchArgs.force = true;

      const result = await actionService.dispatch<{ terminalId: string | null }>(
        "agent.launch",
        dispatchArgs,
        { source: "user" }
      );
      if (gen !== this._launchGen) {
        if (result.ok && result.result?.terminalId) {
          usePanelStore.getState().removePanel(result.result.terminalId);
        }
        this._abandonInFlightLaunch(reservedId, session, { resetAutoLaunch });
        return;
      }

      // Stale-launch guard (preferred-agent auto-launch only): if the user
      // changed preferredAgentId while the IPC was in flight, drop the result
      // and clean up the spawned panel rather than reviving a stale terminal,
      // then re-evaluate against the now-current preference. Read it straight
      // from the store (not the possibly-stale `_lastInputs`) so the re-eval
      // launches the agent that actually superseded this one, never looping on
      // the old agent.
      if (options.preferredAgentLaunch === true) {
        const currentPreferred = useHelpPanelStore.getState().preferredAgentId;
        if (currentPreferred !== launchAgentId) {
          if (result.ok && result.result?.terminalId) {
            usePanelStore.getState().removePanel(result.result.terminalId);
          }
          revokeHelpSession(session?.sessionId ?? null);
          if (this._pendingSessionId === session?.sessionId) {
            this._pendingSessionId = null;
          }
          this._hasAutoLaunched = false;
          // Defer the relaunch to the finally so it runs after `_isLaunching`
          // is released (see `pendingReEval`). Read preferredAgentId straight
          // from the store so the re-eval targets the agent that superseded
          // this one, never looping on the old agent.
          if (this._lastInputs) {
            pendingReEval = { ...this._lastInputs, preferredAgentId: currentPreferred };
          }
          return;
        }
      }

      if (!result.ok || !result.result?.terminalId) {
        if (reservedId) {
          this._pendingNewTerminalId = null;
          useHelpPanelStore.getState().clearTerminal(this.slot);
          revokeHelpSession(session?.sessionId ?? null);
          logError(
            options.force
              ? "Help run-anyway returned no terminal id"
              : "Help new-session returned no terminal id",
            { agentId: launchAgentId }
          );
        } else {
          this._hasAutoLaunched = false;
          revokeHelpSession(session?.sessionId ?? null);
          this._pendingSessionId = null;
          logError("Help launch failed", { agentId: launchAgentId, result });
        }
        this._surfaceLaunchError(launchAgentId, "spawn-failed");
        return;
      }

      const finalTerminalId = result.result.terminalId;
      if (reservedId) {
        this._pendingNewTerminalId = null;
        useHelpPanelStore
          .getState()
          .setTerminal(this.slot, finalTerminalId, launchAgentId, session?.sessionId ?? null);
      } else {
        // Stale-launch guard: handleClose may have revoked the pending
        // session while dispatch was in-flight. Drop the orphan terminal
        // rather than binding a panel to a revoked token.
        const expectedSessionId = session?.sessionId ?? null;
        if (expectedSessionId && this._pendingSessionId !== expectedSessionId) {
          usePanelStore.getState().removePanel(finalTerminalId);
          return;
        }
        useHelpPanelStore
          .getState()
          .setTerminal(this.slot, finalTerminalId, launchAgentId, session?.sessionId ?? null);
        this._pendingSessionId = null;
      }
      reached = true;
      this._patch({ phase: "live" });
      window.electron.help.markTerminal(finalTerminalId).catch((err) => {
        logError("Failed to mark help terminal", err);
      });
    } catch (error) {
      // Revoking the orphaned session token is always safe — it's this flow's
      // own session regardless of supersession. Everything else mutates shared
      // launch state and must only run when THIS launch still owns the
      // generation: a stale rejection (the original hung IPC failing *after* a
      // reveal-reap, watchdog, or newer launch bumped the gen) would otherwise
      // clobber the successfully re-driven launch — a false error banner over a
      // recovered session, or `_hasAutoLaunched` cleared into a duplicate launch.
      const ownsGen = gen === this._launchGen;
      revokeHelpSession(session?.sessionId ?? null);
      if (reservedId) {
        if (ownsGen) {
          this._pendingNewTerminalId = null;
          useHelpPanelStore.getState().clearTerminal(this.slot);
        }
        logError(options.force ? "Help run-anyway failed" : "Help new-session failed", error);
      } else {
        if (ownsGen) {
          this._hasAutoLaunched = false;
          if (this._pendingSessionId === session?.sessionId) {
            this._pendingSessionId = null;
          }
        }
        logError("Help select-agent launch failed", error);
      }
      if (ownsGen) this._surfaceLaunchError(launchAgentId, "spawn-failed");
    } finally {
      // Hand back a resume token this launch took but never spent (#11477).
      // Unconditional on generation: the paths that abandon a launch are
      // dominated by stall reapers and StrictMode remounts, not by a user
      // discarding the conversation — and the discard-intent launches
      // (`newSession` / run-anyway) carry a `reservedId` or `seedPrompt` and so
      // never take at all. Main refuses the put-back if a newer capture landed
      // meanwhile, and a restored entry can only be resumed explicitly.
      // Fire-and-forget: the launch is already unwinding and must not block on
      // an IPC round-trip.
      if (unreleasedHibernation) {
        void this._hibernationManager.releaseToMain(
          unreleasedHibernation.projectId,
          unreleasedHibernation.claimId,
          reached ? "fresh-launch-unused" : "launch-abandoned",
          { clearMirror: unreleasedHibernation.mirrored }
        );
      }
      // Release the re-entrancy guard only if THIS launch() still owns it —
      // clearing it unconditionally let a stale unwind drop a newer launch's
      // guard and admit a concurrent third launch (#10693 review). A
      // non-launch() supersession (auto-launch bumping the gen) leaves the token
      // intact, so this owner still releases.
      if (this._isLaunchingGen === gen) this._isLaunching = false;
      // Watchdog + phase are owned by the current launch generation — a
      // superseding launch has already armed/reset its own.
      if (gen === this._launchGen) {
        this._clearLaunchWatchdog();
        if (!reached) this._resetPhase();
      }
      // Preference changed mid-flight: re-evaluate now that the guard is
      // released so the now-current preferred agent can auto-launch instead of
      // waiting on an incidental render to re-fire the effect.
      if (pendingReEval) this._maybeAutoLaunch(pendingReEval);
    }
  }
}
