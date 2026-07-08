// Idle-hibernate arm/fire with busy-recheck, system-suspend tracking, and
// the main-captured pending-hibernation seed — split out of
// HelpSessionController.ts (#11009). No behavior change — the timers and
// their handlers are unchanged, just relocated.

import { useHelpPanelStore } from "@/store/helpPanelStore";
import { usePanelStore, useProjectStore } from "@/store";
import { isPtyPanel } from "@shared/types/panel";
import { logError } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { ACTIVE_AGENT_STATES } from "@shared/types/agent";
import { buildResumeLatestCommand } from "@shared/types/agentSettings";
import { revokeHelpSession } from "./HelpSessionProvisioner";
import type { HelpSessionSnapshot, HelpSessionInputs } from "./HelpSessionController";

const HIBERNATE_VALID_MINUTES: readonly number[] = [0, 5, 15, 30, 60, 120];
const DEFAULT_HIBERNATE_MINUTES = 5;

// Re-checks every 2 minutes while the agent is busy so hibernation defers
// cleanly until the conversation is idle without restarting the full
// countdown each time.
const HIBERNATE_BUSY_RECHECK_MS = 2 * 60 * 1000;

export interface HibernationManagerHost {
  getSnapshot(): HelpSessionSnapshot;
  patch(partial: Partial<HelpSessionSnapshot>): void;
  resetPhase(): void;
  /** True when `gen` is still the controller's current launch generation. */
  isLaunchCurrent(gen: number): boolean;
}

/**
 * Owns the idle-hibernate arm/fire cycle (with busy-recheck), system-suspend
 * tracking, and the main-captured pending-hibernation seed. Registers its own
 * suspend/wake listeners in `start()`, torn down in `dispose()`.
 */
export class HibernationManager {
  private _isSystemSuspended = false;
  private _hibernateMinutes = DEFAULT_HIBERNATE_MINUTES;
  private _hibernateTimer: ReturnType<typeof setTimeout> | null = null;
  private _hibernateArmedFor: {
    terminalId: string;
    agentId: string | null;
    projectId: string | null;
  } | null = null;
  private _disposers: Array<() => void> = [];

  constructor(private readonly host: HibernationManagerHost) {}

  start(): void {
    const offSuspend = window.electron.systemSleep.onSuspend(() => {
      this._isSystemSuspended = true;
    });
    const offWake = window.electron.systemSleep.onWake(() => {
      this._isSystemSuspended = false;
    });
    this._disposers.push(offSuspend, offWake);
  }

  /** Unsubscribe suspend/wake listeners, clear the timer, and drop the armed identity. */
  dispose(): void {
    for (const dispose of this._disposers) {
      try {
        dispose();
      } catch (err) {
        logError("HibernationManager: disposer threw", err);
      }
    }
    this._disposers = [];
    this.clearTimer();
    this._hibernateArmedFor = null;
  }

  clearTimer(): void {
    if (this._hibernateTimer) {
      clearTimeout(this._hibernateTimer);
      this._hibernateTimer = null;
    }
  }

  /**
   * Clears the timer, drops the armed identity, and discards this project's
   * persisted hibernate entry — the "make stop stick" tail shared by the Stop
   * button, agent self-exit, and the PTY-exit path.
   */
  clearAndSuppress(projectId: string | null): void {
    this.clearTimer();
    this._hibernateArmedFor = null;
    if (projectId) {
      useHelpPanelStore.getState().clearHibernateSession(projectId);
    }
  }

  maybeArm(inputs: HelpSessionInputs): void {
    const { isOpen, terminalId, preferredAgentId } = inputs;
    if (isOpen || !terminalId) {
      this.clearTimer();
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
    this.clearTimer();
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
          this.clearTimer();
          this._hibernateTimer = setTimeout(
            () => this._fireHibernate(initialTerminalId, initialAgentId, initialProjectId),
            this._hibernateMinutes * 60 * 1000
          );
        })
        .catch((err) => {
          if (!this._isStillArmedFor(initialTerminalId)) return;
          logError("HelpPanel: failed to load idleHibernateMinutes", err);
          this._hibernateMinutes = DEFAULT_HIBERNATE_MINUTES;
          this.clearTimer();
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
    this.host.patch({ phase: "hibernating" });

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
            if (this.host.getSnapshot().phase === "hibernating") this.host.resetPhase();
            return;
          }
          // Critical race: user reopened the panel while gracefulKill was
          // in flight. Terminal is still live — don't tear it down out
          // from under them. The captured session ID is also discarded;
          // the next hibernation cycle will capture a fresh one.
          if (after.isOpen) {
            this.host.patch({ phase: "live" });
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
          this.host.resetPhase();
        })
        .catch((err) => {
          const after = useHelpPanelStore.getState();
          if (after.terminalId !== initialTerminalId) {
            // See the `.then()` guard: only reset when this hibernate is still
            // the phase's last writer.
            if (this.host.getSnapshot().phase === "hibernating") this.host.resetPhase();
            return;
          }
          if (after.isOpen) {
            this.host.patch({ phase: "live" });
            return;
          }
          logError("HelpPanel: gracefulKill during hibernate failed", err);
          if (projectId) {
            useHelpPanelStore.getState().clearHibernateSession(projectId);
          }
          usePanelStore.getState().removePanel(initialTerminalId);
          revokeHelpSession(sessionToRevoke);
          useHelpPanelStore.getState().clearTerminal();
          this.host.resetPhase();
        }),
      { context: "HelpPanel:hibernate gracefulKill" }
    );
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
  async seedFromMain(projectId: string, gen: number): Promise<void> {
    try {
      const pending = await window.electron.help.takePendingHibernation(projectId);
      if (!pending) return;
      if (!this.host.isLaunchCurrent(gen)) return;
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
}
