// Assistant CLI version probe + manual "Check again" cooldown, split out of
// HelpSessionController.ts (#11009). No behavior change — the probe
// functions and cooldown state are unchanged, just relocated.

import * as semver from "semver";

import { getAgentConfig } from "@/config/agents";
import { logError } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import type {
  VersionTooOld,
  HelpSessionSnapshot,
  HelpSessionInputs,
} from "./HelpSessionController";

const CHECK_AGAIN_COOLDOWN_MS = 5_000;

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
export async function checkAssistantVersion(
  agentId: string,
  agentName: string,
  refresh = false
): Promise<VersionTooOld | null> {
  const result = await probeAssistantVersion(agentId, agentName, refresh);
  return result.status === "too-old" ? result.block : null;
}

export interface HelpVersionGateHost {
  getSnapshot(): HelpSessionSnapshot;
  patch(partial: Partial<HelpSessionSnapshot>): void;
  getLastInputs(): HelpSessionInputs | null;
  setHasAutoLaunched(value: boolean): void;
  maybeAutoLaunch(inputs: HelpSessionInputs): void;
}

/**
 * Owns the manual "Check again" version re-probe and its cooldown, plus the
 * once-per-session "has this gate ever blocked" flag the core launch FSM
 * consults before probing (`hasBlockedThisSession`).
 */
export class HelpVersionGate {
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

  constructor(private readonly host: HelpVersionGateHost) {}

  /**
   * Tracks whether the version gate has blocked at any point in this panel
   * instance. When true, the next `checkAssistantVersion` call passes
   * `refresh=true` so an externally-updated CLI is detected without waiting
   * for the 12h AgentVersionService cache TTL. Cleared once a probe passes.
   */
  get hasBlockedThisSession(): boolean {
    return this._hasBlockedThisSession;
  }

  setHasBlockedThisSession(value: boolean): void {
    this._hasBlockedThisSession = value;
  }

  /** Clears the cooldown timer — called on controller stop() and preferred-agent change. */
  clearCooldownTimer(): void {
    if (this._checkAgainCooldownTimer) {
      clearTimeout(this._checkAgainCooldownTimer);
      this._checkAgainCooldownTimer = null;
    }
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
  checkAgain(): void {
    const snapshot = this.host.getSnapshot();
    if (snapshot.isCheckingVersion) return;
    const block = snapshot.assistantVersionTooOld;
    if (!block) return;

    const { agentId, agentName } = block;
    this._checkAgainCooldownFired = false;
    this._checkAgainProbeSettled = false;
    this.host.patch({ isCheckingVersion: true });
    this._armCheckAgainCooldownTimer();

    safeFireAndForget(
      probeAssistantVersion(agentId, agentName, true)
        .then((result) => {
          // Stale-agent guard: the user may have switched preferred agents
          // while the probe was in flight — don't act on a result that no
          // longer matches what's blocking.
          if (this.host.getSnapshot().assistantVersionTooOld?.agentId !== agentId) return;
          if (result.status === "too-old") {
            this.host.patch({ assistantVersionTooOld: result.block });
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
          // `_hasAutoLaunched` is required or `maybeAutoLaunch` bails.
          this._hasBlockedThisSession = false;
          this.host.setHasAutoLaunched(false);
          this.host.patch({ assistantVersionTooOld: null });
          const inputs = this.host.getLastInputs();
          if (inputs) this.host.maybeAutoLaunch(inputs);
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

  private _armCheckAgainCooldownTimer(): void {
    this.clearCooldownTimer();
    this._checkAgainCooldownTimer = setTimeout(() => {
      this._checkAgainCooldownTimer = null;
      this._checkAgainCooldownFired = true;
      this._maybeClearCheckingVersion();
    }, CHECK_AGAIN_COOLDOWN_MS);
  }

  // Re-enables the "Check again" button only once both the probe has settled
  // and the 5s cooldown floor has elapsed.
  private _maybeClearCheckingVersion(): void {
    if (this._checkAgainProbeSettled && this._checkAgainCooldownFired) {
      this.host.patch({ isCheckingVersion: false });
    }
  }
}
