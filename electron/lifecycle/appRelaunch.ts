/**
 * App-initiated relaunch (#12320) — the restarts Daintree asks for itself:
 * toggling hardware acceleration, resetting app state, and the GPU crash
 * mitigations. A user who did not ask to restart should get their session back
 * exactly as it was, which the existing call sites broke in two independent
 * ways.
 *
 * **Inherited targeting.** A bare `app.relaunch()` hands the child process the
 * parent's `process.argv` verbatim. Launch from the CLI with `--cli-path`, or
 * from a Linux file manager's "Open in Daintree", and that flag is still in
 * argv hours later — so the relaunch reads as a *targeted* launch to
 * `resolveLaunchIntent`, opens one window on that folder, and abandons the
 * fleet. Stripping the targeting tokens is the whole fix: with them gone the
 * relaunch classifies as `"cold"` on its own, no new intent and no persisted
 * marker required. `stripLaunchTargets` lives beside the classifier in
 * launchIntent.ts so the two cannot drift.
 *
 * **Skipped session capture.** The call sites paired `app.relaunch()` with
 * `app.exit(0)`, which bypasses `before-quit` and therefore the entire shutdown
 * chain — the one place that gracefully kills each project's terminals and
 * persists the `agentSessionId` every `--resume` depends on. An app-initiated
 * restart was consequently the *worst* way to restart: it lost exactly the
 * state a user restarting on purpose would have kept. Routing through the
 * shutdown coordinator runs that chain and then exits into the relaunch.
 */

import { app } from "electron";
import { logInfo, logWarn } from "../utils/logger.js";
import { closeTelemetry } from "../services/TelemetryService.js";
import { startShutdown } from "./shutdownCoordinator.js";
import { stripLaunchTargets } from "./launchIntent.js";

/** Why the app is restarting itself. Diagnostic only — no behaviour keys off it. */
export type AppRelaunchReason = "gpu-toggle" | "gpu-mitigation" | "state-reset";

/**
 * Restart the app, keeping the session.
 *
 * Routed through the shutdown coordinator rather than `app.quit()`, for the
 * reason the previous `app.exit(0)` was chosen over it: `app.quit()` fires
 * `before-quit`, where the quit-confirmation dialog lives, and a restart the
 * user already confirmed must not be vetoable a second time. The coordinator
 * gives the capture chain without the dialog — same primitive the updater uses
 * to install without one — and carries an absolute deadline, so a wedged chain
 * still reaches the exit rather than leaving the app half-restarted.
 *
 * `app.relaunch()` is armed before the chain runs and only takes effect at
 * process exit, so arming early costs nothing and guarantees the deadline-forced
 * exit still comes back up.
 *
 * A refused request means something else already owns the shutdown — an
 * in-flight quit or update install. That process is ending anyway, so the
 * relaunch stays armed and rides it out rather than racing it.
 */
export function relaunchApp(reason: AppRelaunchReason): void {
  // Claim the shutdown BEFORE arming the relaunch. Electron offers no way to
  // cancel an armed relaunch, so arming first and then being refused would
  // leave one queued against whatever exit the current owner is heading for —
  // including a user's deliberate Quit, which would then come back up.
  const result = startShutdown("app-relaunch", () => {
    void closeTelemetry()
      .catch(() => {
        // Telemetry must never hold the restart.
      })
      .finally(() => {
        app.exit(0);
      });
  });

  if (result !== "started") {
    // Something else owns the exit — an in-flight quit, or an update install
    // that is about to replace this binary. That process is ending anyway, and
    // the caller's reason for restarting is served by it.
    logWarn("app.relaunch.refused", { reason, result });
    return;
  }

  const args = stripLaunchTargets(process.argv.slice(1));
  logInfo("app.relaunch", { reason, argCount: args.length });
  // Armed once the chain is ours but before it settles: `startShutdown` carries
  // an absolute deadline that forces the terminal action even on a wedged
  // chain, and the relaunch only takes effect at process exit.
  app.relaunch({ args });
}
