// Encapsulates the renderer-side session lifecycle that previously lived
// inline in HelpPanel.tsx: auto-launch, version probe, MCP provisioning,
// resume-or-fresh, idle hibernate with busy-recheck, gracefulKill, revoke,
// and tier-mismatch handling. The panel subscribes via `useSyncExternalStore`
// and delegates store writes back through the existing `helpPanelStore`
// actions — this controller never shadows persisted state.

import * as semver from "semver";

import { getAgentConfig } from "@/config/agents";
import { actionService } from "@/services/ActionService";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { usePanelStore, useProjectStore } from "@/store";
import { isPtyPanel } from "@shared/types/panel";
import { projectClient } from "@/clients/projectClient";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { ActionContext } from "@shared/types/actions";
import { ACTIVE_AGENT_STATES } from "@shared/types/agent";
import { buildResumeCommand, buildResumeLatestCommand } from "@shared/types/agentSettings";
import { resolveDaintreeMcpTier } from "@shared/types/project";
import type { SnapshotInfo } from "@shared/types/ipc/git";

const HIBERNATE_VALID_MINUTES: readonly number[] = [0, 15, 30, 60, 120];
const DEFAULT_HIBERNATE_MINUTES = 30;

// Re-checks every 2 minutes while the agent is busy so hibernation defers
// cleanly until the conversation is idle without restarting the full
// countdown each time.
const HIBERNATE_BUSY_RECHECK_MS = 2 * 60 * 1000;

const RESUME_BANNER_AUTO_DISMISS_MS = 4_000;
const SNAPSHOT_BANNER_AUTO_DISMISS_MS = 12_000;

// Minimum disabled period after a manual "Check again" click — keeps the
// button from being hammered while a fresh (cache-bypassing) probe runs.
const CHECK_AGAIN_COOLDOWN_MS = 5_000;

export type HelpSessionPhase =
  | "idle"
  | "version-checking"
  | "provisioning"
  | "launching"
  | "live"
  | "hibernating";

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
  | "spawn-failed"
  | "folder-unavailable";

export interface LaunchErrorState {
  agentId: string;
  kind: LaunchErrorKind;
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

export interface HelpSessionSnapshot {
  phase: HelpSessionPhase;
  showResumeBanner: boolean;
  assistantVersionTooOld: VersionTooOld | null;
  tierMismatch: TierMismatchState | null;
  preflightSnapshot: SnapshotInfo | null;
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
}

export interface HelpProjectRef {
  id: string;
  path: string;
}

export interface HelpSessionInputs {
  isOpen: boolean;
  isReadyToLaunch: boolean;
  currentProject: HelpProjectRef | null;
  terminalId: string | null;
  preferredAgentId: string | null;
  supportedInstalledAgentIds: readonly string[];
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
}

interface HelpSessionRef {
  sessionId: string;
  sessionPath: string;
  token: string;
  mcpUrl: string | null;
  windowId: number;
}

/**
 * Per-agent env injection for help-session launches. Today this is a
 * placeholder shape — no agent currently requires renderer-side env beyond
 * the universal `DAINTREE_MCP_TOKEN` / `DAINTREE_WINDOW_ID` set in
 * `buildHelpEnv`. Gemini intentionally does NOT receive `GEMINI_CLI_HOME`:
 * its OAuth credentials live under `os.homedir()` and redirecting them
 * would break auth for users who haven't set `GEMINI_API_KEY`. MCP-server
 * isolation for Gemini comes from the workspace-level
 * `<sessionPath>/.gemini/settings.json` written at provision time, which
 * Gemini's merge precedence (workspace > user) lets shadow same-name
 * user-level entries.
 */
function agentSpawnEnv(_agentId: string, _sessionPath: string): Record<string, string> {
  return {};
}

type ProvisionFailureCode =
  | "MCP_NOT_READY"
  | "MCP_SERVER_NOT_STARTED"
  | "MCP_PROBE_FAILED"
  | "UNKNOWN";

type ProvisionOutcome =
  | { ok: true; session: HelpSessionRef }
  | { ok: false; code: ProvisionFailureCode; message: string };

async function provisionHelpSession(
  project: HelpProjectRef,
  agentId: string,
  context?: ActionContext
): Promise<ProvisionOutcome> {
  try {
    const result = await window.electron.help.provisionSession({
      projectId: project.id,
      projectPath: project.path,
      agentId,
      ...(context && { context }),
    });
    if (!result) {
      return {
        ok: false,
        code: "UNKNOWN",
        message: "Couldn't provision help session.",
      };
    }
    return { ok: true, session: result };
  } catch (err) {
    logError("Failed to provision help session", err);
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as Record<string, unknown>).code
        : undefined;
    const message = formatErrorMessage(err, "Couldn't provision help session");
    if (
      code === "MCP_SERVER_NOT_STARTED" ||
      code === "MCP_PROBE_FAILED" ||
      code === "MCP_NOT_READY"
    ) {
      return { ok: false, code, message };
    }
    return { ok: false, code: "UNKNOWN", message };
  }
}

/**
 * Three-state version probe.
 * - `ok`: version meets the minimum (or no minimum is configured).
 * - `indeterminate`: the probe couldn't get a definitive answer (IPC threw,
 *   no installed version reported, or semver comparison failed).
 * - `too-old`: a definitive too-old result, carrying the gate payload.
 *
 * The launch paths collapse `ok`/`indeterminate` into "proceed" (transient
 * failure is permissive — see `checkAssistantVersion`). The manual
 * "Check again" path keeps them distinct so a transient failure doesn't
 * silently dismiss the gate and auto-launch an outdated CLI.
 */
type VersionProbeResult =
  | { status: "ok" }
  | { status: "indeterminate" }
  | { status: "too-old"; block: VersionTooOld };

function provisionFailureKind(code: ProvisionFailureCode): LaunchErrorKind {
  switch (code) {
    case "MCP_SERVER_NOT_STARTED":
      return "mcp-server-not-started";
    // Legacy `MCP_NOT_READY` errors fall through to the probe-failed shape —
    // the "server responded badly" copy is the closer fit.
    case "MCP_PROBE_FAILED":
    case "MCP_NOT_READY":
      return "mcp-probe-failed";
    default:
      return "spawn-failed";
  }
}

// `refresh=true` bypasses the 12h AgentVersionService cache — pass on retry
// so a user who manually updates the CLI outside Daintree's update flow can
// recover within one panel reopen instead of waiting for cache expiry.
async function probeAssistantVersion(
  agentId: string,
  agentName: string,
  refresh = false
): Promise<VersionProbeResult> {
  const config = getAgentConfig(agentId);
  const required = config?.assistantMinVersion;
  if (!required) return { status: "ok" };

  let info;
  try {
    info = await window.electron.system.getAgentVersion(agentId, refresh);
  } catch (err) {
    logError("Failed to probe assistant CLI version", err);
    return { status: "indeterminate" };
  }

  const installed = info?.installedVersion;
  if (!installed) return { status: "indeterminate" };

  try {
    if (semver.lt(installed, required)) {
      return {
        status: "too-old",
        block: { agentId, agentName, installedVersion: installed, requiredVersion: required },
      };
    }
  } catch (err) {
    logError("Failed to compare assistant CLI version", err);
    return { status: "indeterminate" };
  }
  return { status: "ok" };
}

// Launch-path wrapper preserving the original permissive contract: any
// non-definitive result (ok or indeterminate) returns null so the launch
// proceeds; only a definitive too-old result blocks.
async function checkAssistantVersion(
  agentId: string,
  agentName: string,
  refresh = false
): Promise<VersionTooOld | null> {
  const result = await probeAssistantVersion(agentId, agentName, refresh);
  return result.status === "too-old" ? result.block : null;
}

async function loadCustomLaunchFlags(): Promise<string[]> {
  try {
    const settings = await window.electron.helpAssistant.getSettings();
    const raw = settings.customArgs?.trim();
    if (!raw) return [];
    return raw.split(/\s+/).filter(Boolean);
  } catch (err) {
    logError("Failed to load helpAssistant customArgs", err);
    return [];
  }
}

function buildHelpEnv(
  session: HelpSessionRef | null,
  projectId: string | null,
  agentId: string
): Record<string, string> | undefined {
  if (!session) return undefined;
  const env: Record<string, string> = {
    DAINTREE_MCP_TOKEN: session.token,
    DAINTREE_WINDOW_ID: String(session.windowId),
    ...agentSpawnEnv(agentId, session.sessionPath),
  };
  if (session.mcpUrl) env.DAINTREE_MCP_URL = session.mcpUrl;
  if (projectId) env.DAINTREE_PROJECT_ID = projectId;
  return env;
}

function revokeHelpSession(sessionId: string | null): void {
  if (!sessionId) return;
  window.electron.help.revokeSession(sessionId).catch((err) => {
    logError("Failed to revoke help session", err);
  });
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") return undefined;
    out[k] = v;
  }
  return out;
}

function notifyLaunchFailed(agentId: string, reason: string): void {
  const cfg = getAgentConfig(agentId);
  const name = cfg?.name ?? agentId;
  // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
  notify({
    type: "error",
    title: "Assistant launch failed",
    message: `Couldn't start ${name}. ${reason}`,
  });
}

function notifyAssistantServicesUnavailable(
  kind: "mcp-server-not-started" | "mcp-probe-failed"
): void {
  notify({
    type: "error",
    title: "Assistant couldn't start",
    // Mirror the inline banner's per-kind discrimination on the closed-panel
    // fallback so the two failure modes read differently here too.
    message:
      kind === "mcp-probe-failed"
        ? "Daintree's assistant services didn't respond in time. Check assistant settings, then try again."
        : "Daintree's assistant services didn't start. Check assistant settings, then try again.",
    action: {
      label: "Open settings",
      actionId: "app.settings.openTab",
      actionArgs: { tab: "assistant" },
      onClick: () => {
        void actionService.dispatch("app.settings.openTab", { tab: "assistant" });
      },
    },
  });
}

const INITIAL_SNAPSHOT: HelpSessionSnapshot = Object.freeze({
  phase: "idle",
  showResumeBanner: false,
  assistantVersionTooOld: null,
  tierMismatch: null,
  preflightSnapshot: null,
  isApprovingTier: false,
  isCheckingVersion: false,
  launchError: null,
  mcpActivity: null,
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
  private _snapshot: HelpSessionSnapshot = INITIAL_SNAPSHOT;
  private _listeners = new Set<() => void>();
  private _started = false;
  private _launchGen = 0;
  private _isLaunching = false;
  private _hasAutoLaunched = false;
  private _pendingSessionId: string | null = null;
  private _pendingNewTerminalId: string | null = null;
  /**
   * Tracks whether the version gate has blocked at any point in this panel
   * instance. When true, the next `checkAssistantVersion` call passes
   * `refresh=true` so an externally-updated CLI is detected without waiting
   * for the 12h AgentVersionService cache TTL. Cleared once a probe passes.
   */
  private _hasBlockedThisSession = false;
  /**
   * Backs the manual "Check again" cooldown. `isCheckingVersion` only clears
   * once BOTH the probe has settled (`_checkAgainProbeSettled`) and the 5s
   * minimum-disabled floor has elapsed (`_checkAgainCooldownFired`), so a
   * fast probe can't re-enable the button before the cooldown is up and a
   * slow probe can't be re-enabled by the timer while still in flight.
   */
  private _checkAgainCooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private _checkAgainCooldownFired = false;
  private _checkAgainProbeSettled = false;
  /**
   * Once-per-terminal-id guard for the auto-snapshot pre-flight. Stores the
   * terminal id we last took a snapshot for so React 19 StrictMode's
   * double-invoke can't fire two parallel pre-flights.
   */
  private _preflightSnapshotTerminalId: string | null = null;
  private _isSystemSuspended = false;
  private _hibernateMinutes = DEFAULT_HIBERNATE_MINUTES;
  private _hibernateTimer: ReturnType<typeof setTimeout> | null = null;
  private _resumeBannerTimer: ReturnType<typeof setTimeout> | null = null;
  private _snapshotBannerTimer: ReturnType<typeof setTimeout> | null = null;
  private _disposers: Array<() => void> = [];
  private _lastInputs: HelpSessionInputs | null = null;
  private _hibernateArmedFor: {
    terminalId: string;
    agentId: string | null;
    projectId: string | null;
  } | null = null;

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

    const disposeTier = window.electron.mcpServer.onTierNotPermitted((payload) => {
      const projectId = useProjectStore.getState().currentProject?.id ?? null;
      this._patch({
        tierMismatch: {
          sessionId: payload.sessionId,
          toolId: payload.toolId,
          tier: payload.tier,
          targetTier: payload.targetTier,
          projectId,
        },
      });
    });
    this._disposers.push(disposeTier);

    const disposeToolStarted = window.electron.mcpServer.onToolCallStarted((payload) => {
      this._onToolCallStarted(payload);
    });
    const disposeToolSettled = window.electron.mcpServer.onToolCallSettled((payload) => {
      this._onToolCallSettled(payload);
    });
    this._disposers.push(disposeToolStarted, disposeToolSettled);

    const disposeDisplayImage = window.electron.mcpServer.onDisplayImage((payload) => {
      // The main process already validated the URL and assigned the figure
      // number (#9828); the renderer just records the figure for inline display.
      useHelpPanelStore.getState().addFigure({
        imageId: payload.imageId,
        figureNumber: payload.figureNumber,
        figureLabel: payload.figureLabel,
        url: payload.url,
        ...(payload.caption !== undefined ? { caption: payload.caption } : {}),
        ...(payload.altText !== undefined ? { altText: payload.altText } : {}),
      });
    });
    this._disposers.push(disposeDisplayImage);

    const offSuspend = window.electron.systemSleep.onSuspend(() => {
      this._isSystemSuspended = true;
    });
    const offWake = window.electron.systemSleep.onWake(() => {
      this._isSystemSuspended = false;
    });
    this._disposers.push(offSuspend, offWake);
  }

  stop(): void {
    if (!this._started) return;
    this._started = false;
    for (const dispose of this._disposers) {
      try {
        dispose();
      } catch (err) {
        logError("HelpSessionController: disposer threw", err);
      }
    }
    this._disposers = [];
    this._clearHibernateTimer();
    this._clearResumeBannerTimer();
    this._clearSnapshotBannerTimer();
    this._clearCheckAgainCooldownTimer();
    // Bumping the gen invalidates any in-flight launch so its post-await
    // checkpoints bail. Live store state is left intact so a StrictMode
    // synthetic unmount doesn't tear down the user's session; explicit
    // teardown happens through user-driven paths (`newSession`,
    // `replaceExisting`) or main-side eviction.
    this._launchGen++;
    this._hibernateArmedFor = null;
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
      this._clearCheckAgainCooldownTimer();
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

    this._maybeArmHibernate(inputs);
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
    const store = useHelpPanelStore.getState();
    if (store.terminalId !== terminalId) return;
    revokeHelpSession(store.sessionId);
    this._hasAutoLaunched = false;
    store.clearTerminal();
    // The bound session is gone — drop any lingering activity row so the strip
    // doesn't show stale tool calls for a dead session (#9759).
    this.clearMcpActivity();
  }

  /**
   * Auto-snapshot pre-flight: when the project's MCP tier is `system`, take
   * a pre-flight snapshot once per session and surface a Tier-1 ambient
   * banner. The guard is set synchronously to survive React 19 StrictMode
   * double-invocation; callers should pass `cancelled` to skip the surface
   * on unmount.
   */
  maybeRunPreflightSnapshot(args: {
    terminalId: string | null;
    terminalExists: boolean;
    projectId: string | null;
    worktreeId: string | null;
  }): (() => void) | void {
    const { terminalId, terminalExists, projectId, worktreeId } = args;
    if (!terminalId || !terminalExists) return;
    if (this._preflightSnapshotTerminalId === terminalId) return;
    if (!projectId) return;
    if (!worktreeId) return;

    let cancelled = false;
    this._preflightSnapshotTerminalId = terminalId;
    safeFireAndForget(
      (async () => {
        const settings = await projectClient.getSettings(projectId);
        const tier = resolveDaintreeMcpTier(settings);
        if (tier !== "system") return;
        const snapshot = await window.electron.git.snapshotGet(worktreeId);
        // PreAgentSnapshotService records a sentinel (`stashRef: ""`)
        // before the actual stash completes to coordinate concurrent
        // creation. A sentinel means the snapshot is still in-flight (or
        // failed early) — surfacing the banner would lie about safety.
        if (cancelled || !snapshot || !snapshot.stashRef) return;
        this._patch({ preflightSnapshot: snapshot });
        this._armSnapshotBannerAutoDismiss();
      })().catch((err) => {
        logError("HelpPanel: snapshot pre-flight failed", err);
      }),
      { context: "HelpPanel:snapshot pre-flight" }
    );
    return () => {
      cancelled = true;
    };
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
    const help = useHelpPanelStore.getState();
    const { terminalId, agentId } = help;
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
   * "Run anyway" from the missing-CLI gate — same as `newSession` plus
   * `force: true` so the dispatcher bypasses the missing-CLI guard.
   */
  runAnyway(): void {
    const help = useHelpPanelStore.getState();
    const { terminalId, agentId } = help;
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
   *   2. If `replaceExisting`, remove existing panel and revoke prior sessions.
   *   3. If `requestedId`, set `_pendingNewTerminalId` synchronously, then
   *      write the reservation via `setTerminal(reservedId, agentId, null)`.
   *   4. Only then enter the async provision/dispatch sequence.
   */
  launch(options: HelpLaunchOptions): void {
    const inputs = this._lastInputs;
    const launchAgentId = options.agentId;
    if (!inputs?.isReadyToLaunch || !inputs?.currentProject) {
      notifyLaunchFailed(launchAgentId, "Project state is still loading. Try again.");
      return;
    }
    if (this._isLaunching) return;

    const launchProject = inputs.currentProject;
    this._isLaunching = true;

    // Snapshot the focused worktree/terminal synchronously before any await
    // so the session is pinned to what the user had focused at launch — the
    // HelpPanel footer chip surfaces this binding (#8772), and pinned tool
    // dispatch relies on the same snapshot (#8317).
    const launchContext = actionService.getContext();

    const gen = ++this._launchGen;
    const replaceExisting = options.replaceExisting === true;
    const reservedId = options.requestedId ?? null;
    let presetEnv: Record<string, string> | undefined;

    if (replaceExisting) {
      const existing = useHelpPanelStore.getState();
      const existingTerminalId = existing.terminalId;
      const previousSessionId = existing.sessionId;
      if (existingTerminalId) {
        const panel = usePanelStore.getState().panelsById[existingTerminalId];
        presetEnv = asStringRecord(panel?.extensionState?.presetEnv);
        usePanelStore.getState().removePanel(existingTerminalId);
        revokeHelpSession(previousSessionId);
        if (reservedId) this._revokePendingSession();
        useHelpPanelStore.getState().clearTerminal();
        // Replacing the session — clear the prior session's activity row (#9759)
        // and its figures, since the new help session restarts the figure
        // counter at 1 in the main process (#9828).
        useHelpPanelStore.getState().clearFigures();
        this.clearMcpActivity();
      }
      // Discarding the current conversation invalidates any persisted
      // hibernate entry for this project — leaving it would resume the
      // just-discarded chat on next open.
      if (reservedId) {
        const projectIdForReset = useProjectStore.getState().currentProject?.id ?? null;
        if (projectIdForReset) {
          useHelpPanelStore.getState().clearHibernateSession(projectIdForReset);
        }
        this._patch({ showResumeBanner: false });
      }
    }

    if (reservedId) {
      // Synchronous reservation — must complete before any `await` so the
      // dock filter (#6951) sees `helpPanelStore.terminalId === reservedId`
      // the instant `addPanel` commits.
      this._pendingNewTerminalId = reservedId;
      useHelpPanelStore.getState().setTerminal(reservedId, launchAgentId, null);
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
    this._clearResumeBannerTimer();
    this._patch({ showResumeBanner: false });
  }

  dismissPreflightSnapshot(): void {
    this._clearSnapshotBannerTimer();
    this._patch({ preflightSnapshot: null });
  }

  dismissTierMismatch(): void {
    this._patch({ tierMismatch: null });
  }

  dismissLaunchError(): void {
    this._patch({ launchError: null });
  }

  approveTierOnce(): void {
    const current = this._snapshot.tierMismatch;
    if (!current?.targetTier || this._snapshot.isApprovingTier) return;
    const { sessionId, toolId } = current;
    this._patch({ isApprovingTier: true });
    safeFireAndForget(
      window.electron.mcpServer
        // "Approve once" mints a per-tool, time-bounded grant for this
        // session — it does NOT elevate the session tier. The "Always
        // allow" path is the only remaining caller of `setSessionTier`
        // (#8442).
        .issueGrant({ sessionId, toolId })
        .then(() => {
          this._clearTierMismatchIfStillCurrent(sessionId, toolId);
        })
        .catch((err) => {
          logError("HelpPanel: issueGrant failed", err);
          // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
          notify({
            type: "error",
            title: "Couldn't approve tool",
            message: formatErrorMessage(err, "Couldn't grant access to this tool."),
          });
        })
        .finally(() => {
          this._patch({ isApprovingTier: false });
        }),
      { context: "HelpPanel:issueGrant" }
    );
  }

  alwaysAllowTier(): void {
    const current = this._snapshot.tierMismatch;
    if (!current?.targetTier || this._snapshot.isApprovingTier) return;
    // Use the project captured at event time — `current.projectId` is
    // immutable for this banner, so a project switch after the banner
    // appears doesn't redirect the save to the wrong project.
    const projectId = current.projectId ?? useProjectStore.getState().currentProject?.id ?? null;
    if (!projectId) {
      this.dismissTierMismatch();
      return;
    }
    const { targetTier, sessionId, toolId } = current;
    this._patch({ isApprovingTier: true });
    safeFireAndForget(
      (async () => {
        // projectClient.saveSettings goes directly to the IPC handler —
        // the `project.saveSettings` action sanitizes `daintreeMcpTier`
        // out to keep agents from self-elevating.
        const settings = await projectClient.getSettings(projectId);
        await projectClient.saveSettings(projectId, {
          ...settings,
          daintreeMcpTier: targetTier,
        });
        await window.electron.mcpServer.setSessionTier({ sessionId, tier: targetTier });
        this._clearTierMismatchIfStillCurrent(sessionId, toolId);
      })()
        .catch((err) => {
          logError("HelpPanel: always-allow tier write failed", err);
          // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
          notify({
            type: "error",
            title: "Couldn't save permission",
            message: formatErrorMessage(err, "Couldn't update project tier setting."),
          });
        })
        .finally(() => {
          this._patch({ isApprovingTier: false });
        }),
      { context: "HelpPanel:alwaysAllowTier" }
    );
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
    if (this._snapshot.isCheckingVersion) return;
    const block = this._snapshot.assistantVersionTooOld;
    if (!block) return;

    const { agentId, agentName } = block;
    this._checkAgainCooldownFired = false;
    this._checkAgainProbeSettled = false;
    this._patch({ isCheckingVersion: true });
    this._armCheckAgainCooldownTimer();

    safeFireAndForget(
      probeAssistantVersion(agentId, agentName, true)
        .then((result) => {
          // Stale-agent guard: the user may have switched preferred agents
          // while the probe was in flight — don't act on a result that no
          // longer matches what's blocking.
          if (this._snapshot.assistantVersionTooOld?.agentId !== agentId) return;
          if (result.status === "too-old") {
            this._patch({ assistantVersionTooOld: result.block });
            return;
          }
          if (result.status === "indeterminate") {
            // Couldn't get a definitive answer (transient probe failure).
            // Keep the gate visible rather than dismissing it and
            // auto-launching a CLI that may still be outdated.
            return;
          }
          // status === "ok" — version is now current. Clear the gate and
          // let the normal idle→launch path re-evaluate. Resetting
          // `_hasAutoLaunched` is required or `_maybeAutoLaunch` bails.
          this._hasBlockedThisSession = false;
          this._hasAutoLaunched = false;
          this._patch({ assistantVersionTooOld: null });
          if (this._lastInputs) this._maybeAutoLaunch(this._lastInputs);
        })
        .catch((err) => {
          // probeAssistantVersion already swallows probe failures; this
          // guards against unexpected throws. The gate stays visible as its
          // own retry surface, so no toast.
          logError("HelpPanel: check-again version probe threw", err);
        })
        .finally(() => {
          this._checkAgainProbeSettled = true;
          this._maybeClearCheckingVersion();
        }),
      { context: "HelpPanel:checkVersionAgain" }
    );
  }

  // --- internal ---

  private _resetPhase(): void {
    this._patch({ phase: "idle" });
  }

  private _armCheckAgainCooldownTimer(): void {
    this._clearCheckAgainCooldownTimer();
    this._checkAgainCooldownTimer = setTimeout(() => {
      this._checkAgainCooldownTimer = null;
      this._checkAgainCooldownFired = true;
      this._maybeClearCheckingVersion();
    }, CHECK_AGAIN_COOLDOWN_MS);
  }

  private _clearCheckAgainCooldownTimer(): void {
    if (this._checkAgainCooldownTimer) {
      clearTimeout(this._checkAgainCooldownTimer);
      this._checkAgainCooldownTimer = null;
    }
  }

  // Re-enables the "Check again" button only once both the probe has settled
  // and the 5s cooldown floor has elapsed.
  private _maybeClearCheckingVersion(): void {
    if (this._checkAgainProbeSettled && this._checkAgainCooldownFired) {
      this._patch({ isCheckingVersion: false });
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
    if (this._lastInputs?.isOpen) {
      this._patch({ launchError: Object.freeze({ agentId, kind }) });
      return;
    }
    if (kind === "mcp-server-not-started" || kind === "mcp-probe-failed") {
      notifyAssistantServicesUnavailable(kind);
    } else if (kind === "folder-unavailable") {
      notifyLaunchFailed(agentId, "Help folder is not available.");
    } else {
      notifyLaunchFailed(agentId, "The agent didn't start. Try again.");
    }
  }

  /**
   * Handle a live `tool-call-started` push (#9759). Coalesces bursts within
   * the same turn into a single row ("N calls · latest tool") and clears any
   * lingering errored row — a new call always supersedes the previous result.
   */
  private _onToolCallStarted(
    payload: import("@shared/types/ipc/mcpServer").McpToolCallStartedPayload
  ): void {
    const prev = this._snapshot.mcpActivity;
    // Coalesce only within the same turn: a burst of calls the model fires in
    // one turn collapses to a count, but a new turn starts a fresh row. Calls
    // outside a turn boundary (`turnId` absent) never coalesce — last wins.
    const sameTurn =
      prev !== null &&
      payload.turnId !== undefined &&
      prev.turnId !== undefined &&
      prev.turnId === payload.turnId;
    const callCount = sameTurn && prev ? prev.callCount + 1 : 1;
    // Outstanding-call tracking: a same-turn start joins the burst's pending
    // pool (settled rows have drained to 0). A new turn starts a fresh pool.
    const pendingCalls = sameTurn && prev ? prev.pendingCalls + 1 : 1;
    this._patch({
      mcpActivity: {
        status: "in-flight",
        toolId: payload.toolId,
        argsSummary: payload.argsSummary,
        startedAt: payload.startedAt,
        danger: payload.danger,
        callCount,
        pendingCalls,
        ...(payload.turnId !== undefined ? { turnId: payload.turnId } : {}),
        isError: false,
      },
    });
  }

  /**
   * Handle a live `tool-call-settled` push (#9759). Transitions the current
   * in-flight row to its settled (dimmed glyph + duration) appearance. A push
   * with no current row is ignored — there's nothing on screen to settle.
   */
  private _onToolCallSettled(
    payload: import("@shared/types/ipc/mcpServer").McpToolCallSettledPayload
  ): void {
    const prev = this._snapshot.mcpActivity;
    if (prev === null) return;
    // A settle from a different turn must not regress the current row — a
    // slow call from the previous turn can land after the next turn's call
    // already started. Settles with no turnId (turn boundary already passed,
    // or no turn was active) still apply: they belong to the row last shown.
    if (
      prev.turnId !== undefined &&
      payload.turnId !== undefined &&
      payload.turnId !== prev.turnId
    ) {
      return;
    }
    // Drain one call from the burst's pending pool. While calls remain
    // outstanding the row stays in-flight — an early settle from call A must
    // not flip a coalesced row to "settled" while call B is still running.
    const pendingCalls = Math.max(0, prev.pendingCalls - 1);
    if (prev.status === "in-flight" && pendingCalls > 0) {
      this._patch({ mcpActivity: { ...prev, pendingCalls } });
      return;
    }
    const isError = payload.severity === "error" || payload.severity === "critical";
    this._patch({
      mcpActivity: {
        ...prev,
        status: "settled",
        // Reflect the settled call's tool so the glyph labels the right call
        // even when a burst's latest started differs from what just settled.
        toolId: payload.toolId,
        danger: false,
        durationMs: payload.durationMs,
        result: payload.result,
        severity: payload.severity,
        isError,
        pendingCalls,
      },
    });
  }

  /** Clear the live activity strip (e.g. on session teardown). */
  clearMcpActivity(): void {
    if (this._snapshot.mcpActivity === null) return;
    this._patch({ mcpActivity: null });
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
      next.preflightSnapshot === this._snapshot.preflightSnapshot &&
      next.isApprovingTier === this._snapshot.isApprovingTier &&
      next.isCheckingVersion === this._snapshot.isCheckingVersion &&
      next.launchError === this._snapshot.launchError &&
      next.mcpActivity === this._snapshot.mcpActivity
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

  private _clearHibernateTimer(): void {
    if (this._hibernateTimer) {
      clearTimeout(this._hibernateTimer);
      this._hibernateTimer = null;
    }
  }

  private _clearResumeBannerTimer(): void {
    if (this._resumeBannerTimer) {
      clearTimeout(this._resumeBannerTimer);
      this._resumeBannerTimer = null;
    }
  }

  private _clearSnapshotBannerTimer(): void {
    if (this._snapshotBannerTimer) {
      clearTimeout(this._snapshotBannerTimer);
      this._snapshotBannerTimer = null;
    }
  }

  private _armResumeBannerAutoDismiss(): void {
    this._clearResumeBannerTimer();
    this._resumeBannerTimer = setTimeout(() => {
      this._resumeBannerTimer = null;
      this._patch({ showResumeBanner: false });
    }, RESUME_BANNER_AUTO_DISMISS_MS);
  }

  private _armSnapshotBannerAutoDismiss(): void {
    this._clearSnapshotBannerTimer();
    this._snapshotBannerTimer = setTimeout(() => {
      this._snapshotBannerTimer = null;
      this._patch({ preflightSnapshot: null });
    }, SNAPSHOT_BANNER_AUTO_DISMISS_MS);
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
        const help = useHelpPanelStore.getState();
        if (help.terminalId === reservedId) {
          help.clearTerminal();
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

  private _clearTierMismatchIfStillCurrent(sessionId: string, toolId: string): void {
    const current = this._snapshot.tierMismatch;
    if (current && current.sessionId === sessionId && current.toolId === toolId) {
      this._patch({ tierMismatch: null });
    }
  }

  /**
   * Pulls any main-captured pending hibernation entry for the project and
   * folds it into `helpPanelStore.hibernateSessions` so the existing resume
   * lookup picks it up. Main captures these on LRU eviction / window close
   * when the renderer-side hibernate timer couldn't run because the view was
   * being torn down. Best-effort: failures are logged and swallowed — a
   * missing pending entry just means we'll cold-start the agent like before.
   *
   * The IPC takes-and-clears atomically on main: a one-shot read so a stale
   * entry from many launches ago can't keep resurrecting an old conversation
   * after the user has explicitly started a new session somewhere along the
   * way.
   *
   * Stale-gen guard: the caller passes the launch generation it started in.
   * If anything bumps `_launchGen` during the IPC await (user hits "+ New
   * session" which clears the project's hibernate slot, panel close, etc.),
   * we DROP the pulled entry on the floor instead of writing it back. Main
   * has already cleared the entry on its side (atomic take), so the cost is
   * losing one resume opportunity — much cheaper than resurrecting a
   * conversation the user just explicitly discarded.
   */
  private async _seedHibernateFromMain(projectId: string, gen: number): Promise<void> {
    try {
      const pending = await window.electron.help.takePendingHibernation(projectId);
      if (!pending) return;
      if (gen !== this._launchGen) return;
      // `pending.agentSessionId` can be the empty-string sentinel when main's
      // `revokeSession({ captureHibernation: true })` placeholder write raced
      // the agent's real session-id echo (LRU eviction of the per-project
      // WebContentsView, #10057). The empty sentinel flows through to
      // `_spawnResumed`, which classifies the resume as `"latest"` and the
      // arm sites skip the "Resumed your previous session." banner on that
      // branch — see the comment in `_spawnResumed` and `ResumeSpawnResult`.
      // The root-cause capture race is in main; the fix here is the
      // renderer-side truth-in-trigger only.
      useHelpPanelStore.getState().setHibernateSession(projectId, {
        sessionId: pending.agentSessionId,
        cwd: pending.cwd,
        agentId: pending.agentId,
      });
    } catch (err) {
      logError("HelpPanel: failed to pull pending hibernation from main", err);
    }
  }

  private _maybeArmHibernate(inputs: HelpSessionInputs): void {
    const { isOpen, terminalId, preferredAgentId } = inputs;
    if (isOpen || !terminalId) {
      this._clearHibernateTimer();
      this._hibernateArmedFor = null;
      return;
    }
    // Already armed for this exact terminal+agent — leave the timer.
    if (
      this._hibernateArmedFor &&
      this._hibernateArmedFor.terminalId === terminalId &&
      this._hibernateArmedFor.agentId === preferredAgentId
    ) {
      return;
    }
    this._clearHibernateTimer();
    // Capture the project at arm time so a project switch between panel
    // close and hibernate fire doesn't write project A's session into
    // project B's slot. The fire path reads this captured value, never
    // the live currentProject.
    this._hibernateArmedFor = {
      terminalId,
      agentId: useHelpPanelStore.getState().agentId,
      projectId: useProjectStore.getState().currentProject?.id ?? null,
    };
    const initialTerminalId = terminalId;
    const initialAgentId = this._hibernateArmedFor.agentId;
    const initialProjectId = this._hibernateArmedFor.projectId;

    safeFireAndForget(
      window.electron.helpAssistant
        .getSettings()
        .then((settings) => {
          if (!this._isStillArmedFor(initialTerminalId)) return;
          const minutes = settings.idleHibernateMinutes;
          if (!HIBERNATE_VALID_MINUTES.includes(minutes)) {
            this._hibernateMinutes = DEFAULT_HIBERNATE_MINUTES;
          } else {
            this._hibernateMinutes = minutes;
          }
          if (this._hibernateMinutes <= 0) return;
          this._clearHibernateTimer();
          this._hibernateTimer = setTimeout(
            () => this._fireHibernate(initialTerminalId, initialAgentId, initialProjectId),
            this._hibernateMinutes * 60 * 1000
          );
        })
        .catch((err) => {
          if (!this._isStillArmedFor(initialTerminalId)) return;
          logError("HelpPanel: failed to load idleHibernateMinutes", err);
          this._hibernateMinutes = DEFAULT_HIBERNATE_MINUTES;
          this._clearHibernateTimer();
          this._hibernateTimer = setTimeout(
            () => this._fireHibernate(initialTerminalId, initialAgentId, initialProjectId),
            DEFAULT_HIBERNATE_MINUTES * 60 * 1000
          );
        }),
      { context: "HelpPanel:hibernate getSettings" }
    );
  }

  private _isStillArmedFor(terminalId: string): boolean {
    return this._hibernateArmedFor?.terminalId === terminalId;
  }

  private _fireHibernate(
    initialTerminalId: string,
    initialAgentId: string | null,
    initialProjectId: string | null
  ): void {
    this._hibernateTimer = null;
    if (!this._isStillArmedFor(initialTerminalId)) return;

    const helpState = useHelpPanelStore.getState();
    if (helpState.terminalId !== initialTerminalId) return;
    if (helpState.isOpen) return;
    if (this._isSystemSuspended) return;

    const panelState = usePanelStore.getState();
    const livePanel = panelState.panelsById[initialTerminalId];
    if (!livePanel || !isPtyPanel(livePanel)) return;
    const agentState = livePanel.agentState;
    if (agentState && ACTIVE_AGENT_STATES.has(agentState)) {
      // Re-check shortly without restarting the full hibernate countdown —
      // the user is presumably about to come back.
      this._hibernateTimer = setTimeout(
        () => this._fireHibernate(initialTerminalId, initialAgentId, initialProjectId),
        HIBERNATE_BUSY_RECHECK_MS
      );
      return;
    }

    // Past the active-agent recheck — hibernation will actually run now, so
    // surface it. The panel is closed during the gracefulKill window, so this
    // is only visible if the user reopens mid-teardown (handled below); the
    // teardown completion resets the phase so a later reopen lands on a clean
    // empty state rather than a stuck "Saving session…".
    this._patch({ phase: "hibernating" });

    // Use the projectId captured at arm time, not the live currentProject.
    // The user may have switched projects between panel close and timer
    // fire — writing project A's session into project B's hibernate slot
    // would resume the wrong conversation on next open.
    const projectId = initialProjectId;
    const cwd = livePanel.cwd;
    const sessionToRevoke = helpState.sessionId;
    const liveAgentId = helpState.agentId ?? initialAgentId;

    safeFireAndForget(
      window.electron.terminal
        .gracefulKill(initialTerminalId)
        .then((capturedSessionId) => {
          const after = useHelpPanelStore.getState();
          if (after.terminalId !== initialTerminalId) {
            // Another flow took over the slot, or the panel was torn down
            // (e.g. `handleTerminalPanelMissing` cleared the terminal) while
            // the kill was in flight. If a new launch took over it already
            // wrote its own phase; only when the phase is still "hibernating"
            // is this hibernate the last writer, so drop back to idle and
            // don't strand the "Saving session…" skeleton.
            if (this._snapshot.phase === "hibernating") this._resetPhase();
            return;
          }
          // Critical race: user reopened the panel while gracefulKill was
          // in flight. Terminal is still live — don't tear it down out
          // from under them. The captured session ID is also discarded;
          // the next hibernation cycle will capture a fresh one.
          if (after.isOpen) {
            this._patch({ phase: "live" });
            return;
          }
          if (capturedSessionId && projectId && liveAgentId && cwd) {
            after.setHibernateSession(projectId, {
              sessionId: capturedSessionId,
              cwd,
              agentId: liveAgentId,
            });
          } else if (
            projectId &&
            liveAgentId &&
            cwd &&
            buildResumeLatestCommand(liveAgentId) !== undefined
          ) {
            // Capture missed but the agent has a resume-latest flag — persist
            // a sentinel hibernate entry (empty sessionId) so the next panel
            // open hits the `--continue`-style fallback in `_spawnResumed`
            // instead of starting a fresh session (#8787).
            after.setHibernateSession(projectId, {
              sessionId: "",
              cwd,
              agentId: liveAgentId,
            });
          } else if (projectId) {
            after.clearHibernateSession(projectId);
          }
          usePanelStore.getState().removePanel(initialTerminalId);
          revokeHelpSession(sessionToRevoke);
          useHelpPanelStore.getState().clearTerminal();
          this._resetPhase();
        })
        .catch((err) => {
          const after = useHelpPanelStore.getState();
          if (after.terminalId !== initialTerminalId) {
            // See the `.then()` guard: only reset when this hibernate is still
            // the phase's last writer.
            if (this._snapshot.phase === "hibernating") this._resetPhase();
            return;
          }
          if (after.isOpen) {
            this._patch({ phase: "live" });
            return;
          }
          logError("HelpPanel: gracefulKill during hibernate failed", err);
          if (projectId) {
            useHelpPanelStore.getState().clearHibernateSession(projectId);
          }
          usePanelStore.getState().removePanel(initialTerminalId);
          revokeHelpSession(sessionToRevoke);
          useHelpPanelStore.getState().clearTerminal();
          this._resetPhase();
        }),
      { context: "HelpPanel:hibernate gracefulKill" }
    );
  }

  private _maybeAutoLaunch(inputs: HelpSessionInputs): void {
    if (typeof document !== "undefined" && document.hidden) return;
    if (!inputs.isOpen) return;
    if (!inputs.isReadyToLaunch) return;
    if (!inputs.currentProject) return;
    if (inputs.terminalId) return;
    if (this._hasAutoLaunched) return;

    if (inputs.preferredAgentId) {
      const launchAgentId = inputs.preferredAgentId;
      const launchProject = inputs.currentProject;
      this._hasAutoLaunched = true;
      const gen = ++this._launchGen;
      // Snapshot focus synchronously before the async launch — see launch().
      const launchContext = actionService.getContext();
      safeFireAndForget(this._executeAutoLaunch(gen, launchAgentId, launchProject, launchContext), {
        context: "Auto-launching preferred help agent",
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
    folderPath: string
  ): Promise<ResumeSpawnResult | null> {
    const customLaunchFlags = await loadCustomLaunchFlags();
    const flags = customLaunchFlags.length > 0 ? customLaunchFlags : undefined;
    const hasSpecificSessionId = hibernated.sessionId.length > 0;
    const command = hasSpecificSessionId
      ? (buildResumeCommand(launchAgentId, hibernated.sessionId, flags) ??
        buildResumeLatestCommand(launchAgentId, flags))
      : buildResumeLatestCommand(launchAgentId, flags);
    if (!command) return null;

    const cwd = session?.sessionPath ?? hibernated.cwd ?? folderPath;
    const projectId = useProjectStore.getState().currentProject?.id ?? null;
    const env = buildHelpEnv(session, projectId, launchAgentId);

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

  private async _executeAutoLaunch(
    gen: number,
    launchAgentId: string,
    launchProject: HelpProjectRef,
    launchContext?: ActionContext
  ): Promise<void> {
    let session: HelpSessionRef | null = null;
    // Tracks whether the launch reached its terminal-bound success state. The
    // finally resets the phase to idle on any non-success exit (error, bail)
    // that is still the current generation, so the loading skeleton never
    // sticks; a superseded generation leaves the phase to its new owner.
    let reached = false;
    // Clear any prior failure banner up front so a retry immediately drops the
    // stale error while the new attempt is in flight.
    this._patch({ launchError: null });
    try {
      this._patch({ phase: "version-checking" });
      const folderPath = await window.electron.help.getFolderPath();
      if (gen !== this._launchGen) {
        this._abandonInFlightLaunch(null, session, { resetAutoLaunch: true });
        return;
      }
      if (!folderPath) {
        this._hasAutoLaunched = false;
        this._surfaceLaunchError(launchAgentId, "folder-unavailable");
        return;
      }

      const launchAgentName = getAgentConfig(launchAgentId)?.name ?? launchAgentId;
      const versionBlock = await checkAssistantVersion(
        launchAgentId,
        launchAgentName,
        this._hasBlockedThisSession
      );
      if (gen !== this._launchGen) {
        this._abandonInFlightLaunch(null, session, { resetAutoLaunch: true });
        return;
      }
      if (versionBlock) {
        // Stale-agent guard: skip the block if the user changed
        // preferredAgentId while the probe was in flight — the new
        // agent's empty state shouldn't be covered by an "Update Claude"
        // message that no longer applies.
        if (useHelpPanelStore.getState().preferredAgentId !== launchAgentId) {
          this._hasAutoLaunched = false;
          return;
        }
        this._hasAutoLaunched = false;
        this._hasBlockedThisSession = true;
        this._patch({ assistantVersionTooOld: versionBlock });
        return;
      }
      this._hasBlockedThisSession = false;
      this._patch({ assistantVersionTooOld: null, phase: "provisioning" });

      const outcome = await provisionHelpSession(launchProject, launchAgentId, launchContext);
      if (gen !== this._launchGen) {
        if (outcome.ok) session = outcome.session;
        this._abandonInFlightLaunch(null, session, { resetAutoLaunch: true });
        return;
      }
      if (!outcome.ok) {
        this._hasAutoLaunched = false;
        this._surfaceLaunchError(launchAgentId, provisionFailureKind(outcome.code));
        return;
      }
      session = outcome.session;
      this._pendingSessionId = session.sessionId;
      this._patch({ phase: "launching" });
      const cwd = session.sessionPath;
      const env = buildHelpEnv(session, launchProject.id, launchAgentId);

      // Seed hibernate from main's pending-hibernation store BEFORE the
      // local lookup — this is what carries the conversation across LRU
      // eviction / window close where the renderer-side hibernate timer
      // couldn't capture before its view was destroyed. Passing `gen` lets
      // the helper drop the pulled entry if a discarding action (e.g.
      // "+ New session") supersedes this launch mid-IPC.
      await this._seedHibernateFromMain(launchProject.id, gen);
      if (gen !== this._launchGen) {
        this._abandonInFlightLaunch(null, session, { resetAutoLaunch: true });
        return;
      }
      const hibernated = useHelpPanelStore.getState().hibernateSessions[launchProject.id];
      if (hibernated && hibernated.agentId === launchAgentId) {
        const resumed = await this._spawnResumed(launchAgentId, hibernated, session, folderPath);
        if (gen !== this._launchGen) {
          if (resumed) usePanelStore.getState().removePanel(resumed.panelId);
          this._abandonInFlightLaunch(null, session, { resetAutoLaunch: true });
          return;
        }
        if (resumed) {
          // Stale-launch guard: handleClose may have revoked the pending
          // session while addPanel was in flight.
          const expectedSessionId = session.sessionId;
          if (this._pendingSessionId !== expectedSessionId) {
            usePanelStore.getState().removePanel(resumed.panelId);
            this._hasAutoLaunched = false;
            return;
          }
          useHelpPanelStore.getState().clearHibernateSession(launchProject.id);
          useHelpPanelStore
            .getState()
            .setTerminal(resumed.panelId, launchAgentId, session.sessionId);
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
            this._armResumeBannerAutoDismiss();
          }
          return;
        }
        // Resume failed — drop the stale entry so we don't loop, then fall
        // through to fresh launch using the already-provisioned session.
        useHelpPanelStore.getState().clearHibernateSession(launchProject.id);
      }

      const customLaunchFlags = await loadCustomLaunchFlags();
      if (gen !== this._launchGen) {
        this._abandonInFlightLaunch(null, session, { resetAutoLaunch: true });
        return;
      }

      const result = await actionService.dispatch<{ terminalId: string | null }>(
        "agent.launch",
        {
          agentId: launchAgentId,
          location: "overlay",
          cwd,
          excludeFromPersistence: true,
          removeOnExit: true,
          ...(env && { env }),
          ...(customLaunchFlags.length > 0 && { agentLaunchFlags: customLaunchFlags }),
        },
        { source: "user" }
      );
      if (gen !== this._launchGen) {
        if (result.ok && result.result?.terminalId) {
          usePanelStore.getState().removePanel(result.result.terminalId);
        }
        this._abandonInFlightLaunch(null, session, { resetAutoLaunch: true });
        return;
      }

      // Stale-launch guard: if the user changed preferredAgentId while the
      // IPC was in flight, drop the result and clean up the spawned panel
      // rather than reviving a stale terminal.
      const currentPreferred = useHelpPanelStore.getState().preferredAgentId;
      if (currentPreferred !== launchAgentId) {
        if (result.ok && result.result?.terminalId) {
          usePanelStore.getState().removePanel(result.result.terminalId);
        }
        revokeHelpSession(session?.sessionId ?? null);
        this._pendingSessionId = null;
        this._hasAutoLaunched = false;
        // The preference changed mid-launch, so re-evaluate against the
        // current inputs rather than waiting on an incidental re-render to
        // re-fire the effect — the new preferred agent should auto-launch
        // now. Earlier this was driven solely by the next syncInputs render,
        // which a transient phase re-render could consume before this reset
        // landed, swallowing the relaunch. Read `preferredAgentId` straight
        // from the store (not the possibly-stale `_lastInputs`) so the re-eval
        // launches the agent that actually superseded this one, never looping
        // on the old agent.
        if (this._lastInputs) {
          this._maybeAutoLaunch({ ...this._lastInputs, preferredAgentId: currentPreferred });
        }
        return;
      }

      if (!result.ok || !result.result?.terminalId) {
        this._hasAutoLaunched = false;
        revokeHelpSession(session?.sessionId ?? null);
        this._pendingSessionId = null;
        logError("Help auto-launch failed", { agentId: launchAgentId, result });
        this._surfaceLaunchError(launchAgentId, "spawn-failed");
        return;
      }

      const expectedSessionId = session?.sessionId ?? null;
      if (expectedSessionId && this._pendingSessionId !== expectedSessionId) {
        usePanelStore.getState().removePanel(result.result.terminalId);
        this._hasAutoLaunched = false;
        return;
      }

      useHelpPanelStore
        .getState()
        .setTerminal(result.result.terminalId, launchAgentId, session?.sessionId ?? null);
      this._pendingSessionId = null;
      reached = true;
      this._patch({ phase: "live" });
      window.electron.help.markTerminal(result.result.terminalId).catch((err) => {
        logError("Failed to mark help terminal", err);
      });
    } catch (err) {
      logError("HelpPanel: auto-launch threw", err);
      this._hasAutoLaunched = false;
      // Mirror _executeLaunch's catch: an unexpected throw past the
      // provision step (e.g. agent.launch rejecting) leaves a live session
      // token with no bound terminal. Revoke it, clear the pending-session
      // guard, and surface the failure so the panel isn't left silently empty.
      revokeHelpSession(session?.sessionId ?? null);
      this._pendingSessionId = null;
      this._surfaceLaunchError(launchAgentId, "spawn-failed");
    } finally {
      if (gen === this._launchGen && !reached) this._resetPhase();
    }
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
    // See `_executeAutoLaunch`: the finally drops the phase back to idle on a
    // non-success exit that's still the current generation.
    let reached = false;
    // Clear any prior failure banner up front so a retry immediately drops the
    // stale error while the new attempt is in flight.
    this._patch({ launchError: null });
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
          this._hasBlockedThisSession
        );
        if (gen !== this._launchGen) {
          this._abandonInFlightLaunch(reservedId, session, { resetAutoLaunch });
          return;
        }
        if (versionBlock) {
          this._hasAutoLaunched = false;
          this._hasBlockedThisSession = true;
          this._patch({ assistantVersionTooOld: versionBlock });
          return;
        }
        this._hasBlockedThisSession = false;
        this._patch({ assistantVersionTooOld: null, phase: "provisioning" });
      }

      const outcome = await provisionHelpSession(launchProject, launchAgentId, launchContext);
      if (gen !== this._launchGen) {
        if (outcome.ok) session = outcome.session;
        this._abandonInFlightLaunch(reservedId, session, { resetAutoLaunch });
        return;
      }
      if (!outcome.ok) {
        if (reservedId) {
          this._pendingNewTerminalId = null;
          useHelpPanelStore.getState().clearTerminal();
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
      const cwd = session.sessionPath;
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
        await this._seedHibernateFromMain(launchProject.id, gen);
        if (gen !== this._launchGen) {
          this._abandonInFlightLaunch(reservedId, session, { resetAutoLaunch });
          return;
        }
        const hibernated = useHelpPanelStore.getState().hibernateSessions[launchProject.id];
        if (hibernated && hibernated.agentId === launchAgentId && folderPath) {
          const resumed = await this._spawnResumed(launchAgentId, hibernated, session, folderPath);
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
            useHelpPanelStore.getState().clearHibernateSession(launchProject.id);
            useHelpPanelStore
              .getState()
              .setTerminal(resumed.panelId, launchAgentId, session.sessionId);
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
              this._armResumeBannerAutoDismiss();
            }
            return;
          }
          useHelpPanelStore.getState().clearHibernateSession(launchProject.id);
        }
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

      if (!result.ok || !result.result?.terminalId) {
        if (reservedId) {
          this._pendingNewTerminalId = null;
          useHelpPanelStore.getState().clearTerminal();
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
          .setTerminal(finalTerminalId, launchAgentId, session?.sessionId ?? null);
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
          .setTerminal(finalTerminalId, launchAgentId, session?.sessionId ?? null);
        this._pendingSessionId = null;
      }
      reached = true;
      this._patch({ phase: "live" });
      window.electron.help.markTerminal(finalTerminalId).catch((err) => {
        logError("Failed to mark help terminal", err);
      });
    } catch (error) {
      if (reservedId) {
        this._pendingNewTerminalId = null;
        useHelpPanelStore.getState().clearTerminal();
        revokeHelpSession(session?.sessionId ?? null);
        logError(options.force ? "Help run-anyway failed" : "Help new-session failed", error);
      } else {
        this._hasAutoLaunched = false;
        revokeHelpSession(session?.sessionId ?? null);
        this._pendingSessionId = null;
        logError("Help select-agent launch failed", error);
      }
      this._surfaceLaunchError(launchAgentId, "spawn-failed");
    } finally {
      this._isLaunching = false;
      if (gen === this._launchGen && !reached) this._resetPhase();
    }
  }
}
