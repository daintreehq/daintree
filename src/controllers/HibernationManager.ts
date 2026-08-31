// Idle-hibernate arm/fire with busy-recheck, system-suspend tracking, and
// the main-captured pending-hibernation seed — split out of
// HelpSessionController.ts (#11009). No behavior change — the timers and
// their handlers are unchanged, just relocated.

import { useHelpPanelStore } from "@/store/helpPanelStore";
import { usePanelStore } from "@/store";
import { isPtyPanel } from "@shared/types/panel";
import { logError, logInfo } from "@/utils/logger";
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
  /**
   * The assistant lane this manager hibernates and resumes (#12108). A
   * function because the controller builds this in a class field initializer,
   * before its own constructor body has assigned the lane.
   */
  getSlot(): number;
  /** This lane's live state, so a sibling's terminal is never mistaken for ours. */
  getSlotState(): { terminalId: string | null; agentId: string | null; sessionId: string | null };
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
      useHelpPanelStore.getState().clearHibernateSession(projectId, this.host.getSlot());
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
    // Never arm without a workspace to key the entry on. `_fireHibernate` would
    // tear the session down (kill the PTY, revoke, clear the terminal) and then
    // skip every `if (projectId)` persistence branch — destroying the
    // conversation instead of hibernating it. Bailing here keeps the session
    // alive until a workspace is known; because we return BEFORE touching
    // `_hibernateArmedFor`, an arm already captured against a real workspace
    // survives a transient null and keeps its own countdown (the anti-bleed
    // capture below). Reachable when the active workspace pointer is
    // transiently null — e.g. the scratch pointer being cleared out from under
    // a closed panel (#11068).
    const workspaceId = inputs.currentProject?.id ?? null;
    if (!workspaceId) return;
    this.clearTimer();
    // Capture the workspace at arm time so a workspace switch between panel
    // close and hibernate fire doesn't write workspace A's session into
    // workspace B's slot. The fire path reads this captured value, never live
    // store state. Sourced from the synced inputs rather than the project
    // store: the active workspace may be a scratch, which leaves
    // `currentProject` null by design (#11068).
    this._hibernateArmedFor = {
      terminalId,
      agentId: this.host.getSlotState().agentId,
      projectId: workspaceId,
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

    const helpState = this.host.getSlotState();
    if (helpState.terminalId !== initialTerminalId) return;
    if (useHelpPanelStore.getState().isOpen) return;
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
          if (this.host.getSlotState().terminalId !== initialTerminalId) {
            // Another flow took over the lane, or the panel was torn down
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
            after.setHibernateSession(projectId, this.host.getSlot(), {
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
            after.setHibernateSession(projectId, this.host.getSlot(), {
              sessionId: "",
              cwd,
              agentId: liveAgentId,
            });
          } else if (projectId) {
            after.clearHibernateSession(projectId, this.host.getSlot());
          }
          usePanelStore.getState().removePanel(initialTerminalId);
          revokeHelpSession(sessionToRevoke);
          useHelpPanelStore.getState().clearTerminal(this.host.getSlot());
          this.host.resetPhase();
        })
        .catch((err) => {
          if (this.host.getSlotState().terminalId !== initialTerminalId) {
            // See the `.then()` guard: only reset when this hibernate is still
            // the phase's last writer.
            if (this.host.getSnapshot().phase === "hibernating") this.host.resetPhase();
            return;
          }
          if (useHelpPanelStore.getState().isOpen) {
            this.host.patch({ phase: "live" });
            return;
          }
          logError("HelpPanel: gracefulKill during hibernate failed", err);
          if (projectId) {
            useHelpPanelStore.getState().clearHibernateSession(projectId, this.host.getSlot());
          }
          usePanelStore.getState().removePanel(initialTerminalId);
          revokeHelpSession(sessionToRevoke);
          useHelpPanelStore.getState().clearTerminal(this.host.getSlot());
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
   * Stale-gen guard: the caller passes the launch generation it started in. If
   * anything bumps `_launchGen` during the IPC await, this launch no longer
   * owns the entry and must not write it into the store. It used to be dropped
   * on the floor here — main had already cleared its side, so the resume
   * opportunity was simply destroyed — on the theory that the bump meant the
   * user had explicitly discarded the conversation. It usually doesn't: the
   * gen-bump sites are dominated by the stall watchdog, the stranded-launch
   * reaper, and StrictMode remounts, and the watchdog in particular surfaces a
   * *retryable* error while silently destroying what the retry needs (#11477).
   * So hand it back to main instead. `restorePendingHibernation` refuses if a
   * newer capture has landed, and the put-back entry loses `panelWasOpen`, so
   * it can only ever be resumed explicitly — never auto-resumed.
   *
   * Returns `"seeded"` when the entry is now live in the store and the caller
   * owns it (and so must consume or release it), `"released"` when it went
   * back to main, and `"empty"` when there was nothing to take.
   */
  async seedFromMain(
    projectId: string,
    gen: number
  ): Promise<{ status: "seeded"; claimId: string } | { status: "released" | "empty" }> {
    // Tracked outside the try so a throw from the store write below still
    // releases the claim main has already handed us — the take is the point of
    // no return, and swallowing it in the catch would lose the token exactly
    // the way this fix exists to prevent.
    let claimId: string | null = null;
    // Whether this take reached the store write below, so a release knows if
    // the mirror is ours to drop.
    let mirrored = false;
    try {
      const pending = await window.electron.help.takePendingHibernation(
        projectId,
        this.host.getSlot()
      );
      if (!pending) return { status: "empty" };
      claimId = pending.claimId;
      if (!this.host.isLaunchCurrent(gen)) {
        // Nothing seeded yet — leave whatever the slot holds alone.
        await this.releaseToMain(projectId, claimId, "stale-generation", { clearMirror: false });
        return { status: "released" };
      }
      // `pending.agentSessionId` can be the empty-string sentinel when main's
      // `revokeSession({ captureHibernation: true })` placeholder write raced
      // the agent's real session-id echo (LRU eviction of the per-project
      // WebContentsView, #10057). The empty sentinel flows through to
      // `_spawnResumed`, which classifies the resume as `"latest"` and the
      // arm sites skip the "Resumed your previous session." banner on that
      // branch — see the comment in `_spawnResumed` and `ResumeSpawnResult`.
      // The root-cause capture race is in main; the fix here is the
      // renderer-side truth-in-trigger only.
      useHelpPanelStore.getState().setHibernateSession(projectId, this.host.getSlot(), {
        sessionId: pending.agentSessionId,
        cwd: pending.cwd,
        agentId: pending.agentId,
      });
      mirrored = true;
      return { status: "seeded", claimId: pending.claimId };
    } catch (err) {
      logError("HelpPanel: failed to pull pending hibernation from main", err);
      if (claimId) {
        await this.releaseToMain(projectId, claimId, "seed-threw", { clearMirror: mirrored });
        return { status: "released" };
      }
      return { status: "empty" };
    }
  }

  /**
   * Hand a taken-but-unused pending-hibernation entry back to main (#11477).
   *
   * Main restores from its own take-side stash, so this only reports that the
   * caller isn't going to use what it took — nothing about the entry crosses
   * the bridge. Best-effort: a failed put-back is exactly the old behaviour
   * (one lost resume opportunity), so it is logged and swallowed rather than
   * failing the launch that is already unwinding.
   *
   * Pass `clearMirror` when this take was written into the renderer's durable
   * `hibernateSessions` slot. The two must then move together: releasing main's
   * copy while leaving the mirror behind would let a later launch resume from
   * the mirror after main had already handed the entry to a different window —
   * two windows resuming one conversation, which is exactly the single-winner
   * invariant the atomic take exists to hold (#10820).
   *
   * It is NOT unconditional, because several release paths abort before
   * mirroring anything: the stale-generation guard below, and the early
   * `resumeOnly` take's generation/agent-mismatch bails. Clearing there would
   * delete whatever the slot already held — a graceful-hibernate entry from a
   * panel close, or a newer entry — which this launch never owned.
   *
   * `reason` is carried into the log so a future incident can tell which abort
   * path fired instead of inferring it from an absence, which is what made the
   * original report take log archaeology to diagnose.
   */
  async releaseToMain(
    projectId: string,
    claimId: string,
    reason: string,
    opts: { clearMirror: boolean }
  ): Promise<void> {
    if (opts.clearMirror) {
      useHelpPanelStore.getState().clearHibernateSession(projectId, this.host.getSlot());
    }
    try {
      const restored = await window.electron.help.restorePendingHibernation(
        projectId,
        claimId,
        this.host.getSlot()
      );
      logInfo("HelpPanel: released pending hibernation back to main", {
        projectId,
        reason,
        restored,
      });
    } catch (err) {
      logError("HelpPanel: failed to release pending hibernation back to main", err);
    }
  }
}
