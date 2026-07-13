// Ownership registry for the one graceful-shutdown chain (issue #11104).
//
// Two callers can decide the process must die: the `before-quit` listener in
// shutdown.ts (user quit, signal, session-end) and AutoUpdaterService when the
// user installs an update. Both must run the SAME cleanup chain, and exactly
// one of them must own the terminal action that ends the process — otherwise a
// normal quit's `app.exit()` races the update path's `quitAndInstall()`.
//
// Kept as a leaf module (no heavy imports), mirroring signalShutdownState.ts:
// shutdown.ts eagerly imports half the service layer, so AutoUpdaterService
// importing it directly would be an import cycle. shutdown.ts registers its
// chain here as the runner instead.

import { app } from "electron";
import { SHUTDOWN_DEADLINE_MS } from "./shutdownConfig.js";

export type ShutdownOutcome = "clean" | "dirty";
export type ShutdownInitiator = "app-quit" | "update-install";

// "cleaning" — the chain is running; the process must not be torn down under it.
// "handoff"  — the chain settled and the owner's terminal action is running
//              (app.exit, or quitAndInstall and the app.quit Squirrel issues
//              behind it). A quit arriving now is the terminal action landing,
//              not an interruption.
type ShutdownPhase = "cleaning" | "handoff";

export type ShutdownRequestResult = "started" | "already-shutting-down" | "unavailable";

interface ActiveShutdown {
  initiator: ShutdownInitiator;
  phase: ShutdownPhase;
}

type ShutdownRunner = () => Promise<ShutdownOutcome>;

let runner: ShutdownRunner | null = null;
let active: ActiveShutdown | null = null;

export const setShutdownRunner = (fn: ShutdownRunner | null): void => {
  runner = fn;
};

export const getActiveShutdown = (): Readonly<ActiveShutdown> | null => active;

// True while the cleanup chain is still running. A `before-quit` landing in this
// window must be preventDefault()'d — Electron would otherwise close the windows
// and terminate the process out from under an in-flight chain, losing exactly the
// journaling/checkpoint work this coordinator exists to guarantee.
export const isCleaningUp = (): boolean => active?.phase === "cleaning";

// Claims ownership of the shutdown and starts (or joins) the cleanup chain.
// `onSettled` runs the caller's terminal action once the chain resolves — phase
// flips to "handoff" in the same synchronous turn, so there is no window where
// the chain has settled but the terminal action hasn't been issued.
//
// The first caller wins. A second, differently-intentioned request is refused
// rather than queued: the losing caller must not attach a second terminal action.
export function startShutdown(
  initiator: ShutdownInitiator,
  onSettled: (outcome: ShutdownOutcome) => void
): ShutdownRequestResult {
  if (!runner) return "unavailable";
  if (active) return "already-shutting-down";

  const run: ActiveShutdown = { initiator, phase: "cleaning" };
  active = run;

  // Start the chain. `runner` is an async function, so a throw in its synchronous
  // prefix surfaces as a rejection — but wrap it anyway: a synchronous throw here
  // would leave `active` stuck in "cleaning" forever, and a shutdown stuck in
  // "cleaning" is an app that can never be quit (see the before-quit listener).
  let chain: Promise<ShutdownOutcome>;
  try {
    chain = runner();
  } catch (err) {
    console.error("[MAIN] Shutdown runner threw synchronously:", err);
    chain = Promise.resolve("dirty");
  }

  // The chain reports its own failures as "dirty"; a rejection means the chain
  // itself broke.
  const settled = chain.catch((err: unknown) => {
    console.error("[MAIN] Shutdown chain rejected unexpectedly:", err);
    return "dirty" as ShutdownOutcome;
  });

  // Absolute deadline. Every budget inside the chain is bounded, but this is the
  // structural guarantee that the terminal action ALWAYS runs: without it, one
  // unbounded await anywhere in the chain would hang the run in "cleaning" and
  // make the app unquittable. Resolves (never rejects) so it cannot itself strand
  // the handoff.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ShutdownOutcome>((resolve) => {
    deadlineTimer = setTimeout(() => {
      console.error(
        `[MAIN] Shutdown exceeded its ${SHUTDOWN_DEADLINE_MS}ms deadline — forcing the terminal action`
      );
      resolve("dirty");
    }, SHUTDOWN_DEADLINE_MS);
  });

  void Promise.race([settled, deadline]).then((outcome) => {
    clearTimeout(deadlineTimer);
    // Flip to "handoff" BEFORE invoking the terminal action, in the same
    // synchronous turn: onSettled issues quitAndInstall(), and Squirrel's
    // app.quit() behind it must be allowed through the before-quit listener.
    run.phase = "handoff";
    try {
      onSettled(outcome);
    } catch (err) {
      // A terminal action that throws would leave a torn-down process alive with
      // nothing left to end it. Nothing sane to do but exit.
      console.error("[MAIN] Shutdown terminal action threw:", err);
      app.exit(1);
    }
  });

  return "started";
}

// AutoUpdaterService's entry point. `onReadyToInstall` must invoke the updater
// synchronously — the phase is already "handoff" when it runs, so any deferral
// reopens the window where a quit could slip past and skip the install.
export const requestGracefulShutdownForUpdate = (
  onReadyToInstall: (outcome: ShutdownOutcome) => void
): ShutdownRequestResult => startShutdown("update-install", onReadyToInstall);

// Test-only: the module singleton persists across tests that don't reset modules.
export const resetShutdownCoordinatorForTests = (): void => {
  runner = null;
  active = null;
};
