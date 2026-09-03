import { systemPreferences } from "electron";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

type StateCallback = (osDndActive: boolean | undefined) => void;

/**
 * OsDndService — surfaces the OS-level Do-Not-Disturb / Focus state to the
 * renderer.
 *
 * @pattern Factory/Accessor Methods (Pattern C)
 *
 * macOS (primary supported platform):
 *   - Initial state probed once via `plutil` reading
 *     `~/Library/DoNotDisturb/DB/Assertions.json` — a non-empty mode
 *     identifier means a Focus mode (including classic DND) is active.
 *   - Live updates via `systemPreferences.subscribeNotification` on the
 *     private `_NSDoNotDisturbEnabledNotification` /
 *     `_NSDoNotDisturbDisabledNotification` Darwin notifications. These are
 *     not in the public macOS SDK but have been the canonical DND/Focus
 *     transition signals since macOS 12 and remain wired through Focus modes.
 *
 * Windows / Linux: state is left `undefined`. Cross-desktop Linux DND
 * detection has no reliable standard, and Windows Focus Assist has no
 * Electron-exposed event subscription — failing soft is the correct choice
 * for both.
 *
 * The state is consumed in two places only: the informational-audio gate in
 * `AgentNotificationService` (working pulse and all-clear) and the read-only
 * toolbar tooltip display. It must NEVER be used to suppress in-app toasts.
 */
class OsDndService {
  private state: boolean | undefined = undefined;
  private initialized = false;
  private subscriptionIds: number[] = [];
  private listeners = new Set<StateCallback>();

  initialize(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    if (process.platform !== "darwin") {
      // No detection available — leave state undefined.
      return;
    }

    this.state = this.probeMacOsInitialState();

    try {
      const enabledId = systemPreferences.subscribeNotification(
        "_NSDoNotDisturbEnabledNotification",
        () => this.applyState(true)
      );
      this.subscriptionIds.push(enabledId);
    } catch (err) {
      console.warn("[OsDndService] Failed to subscribe to DND-enabled notification:", err);
    }

    try {
      const disabledId = systemPreferences.subscribeNotification(
        "_NSDoNotDisturbDisabledNotification",
        () => this.applyState(false)
      );
      this.subscriptionIds.push(disabledId);
    } catch (err) {
      console.warn("[OsDndService] Failed to subscribe to DND-disabled notification:", err);
    }
  }

  /**
   * macOS initial-state probe. The subscription only fires on transitions, so
   * without this we'd report `undefined` until the user toggled DND. The
   * `Assertions.json` file lists the active Focus-mode assertions; an empty
   * read means no mode is active. Anything that throws (file missing, parse
   * failure, sandbox restriction) collapses to `undefined` — fail-soft.
   */
  private probeMacOsInitialState(): boolean | undefined {
    const assertionsPath = path.join(
      os.homedir(),
      "Library",
      "DoNotDisturb",
      "DB",
      "Assertions.json"
    );
    try {
      const out = execFileSync(
        "/usr/bin/plutil",
        [
          "-extract",
          "data.0.storeAssertionRecords.0.assertionDetailsModeIdentifier",
          "raw",
          "-o",
          "-",
          assertionsPath,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1500 }
      );
      return out.trim().length > 0;
    } catch {
      // Assertions.json may not exist if the user has never enabled DND, or
      // plutil may exit non-zero when no assertion is set. Either case means
      // DND is not active — return false, not undefined, so the probe still
      // produces useful state when the file is simply absent.
      return false;
    }
  }

  private applyState(next: boolean): void {
    if (this.state === next) return;
    this.state = next;
    for (const callback of this.listeners) {
      try {
        callback(next);
      } catch (err) {
        console.error("[OsDndService] State callback error:", err);
      }
    }
  }

  /**
   * Current DND state. `undefined` means "unknown" (unsupported platform or
   * detection failed) — consumers must treat it as "do not gate".
   */
  getState(): boolean | undefined {
    return this.state;
  }

  /**
   * Subscribe to DND transitions. Returns an unsubscribe function.
   */
  onStateChanged(callback: StateCallback): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  dispose(): void {
    if (!this.initialized) return;
    for (const id of this.subscriptionIds) {
      try {
        systemPreferences.unsubscribeNotification(id);
      } catch (err) {
        console.warn("[OsDndService] Failed to unsubscribe DND notification:", err);
      }
    }
    this.subscriptionIds = [];
    this.listeners.clear();
    this.state = undefined;
    this.initialized = false;
  }
}

let osDndService: OsDndService | null = null;

export function getOsDndService(): OsDndService {
  if (!osDndService) {
    osDndService = new OsDndService();
  }
  return osDndService;
}

export function initializeOsDndService(): OsDndService {
  const service = getOsDndService();
  service.initialize();
  return service;
}

/** Test-only: reset the singleton so each test starts clean. */
export function __resetOsDndServiceForTests(): void {
  if (osDndService) {
    osDndService.dispose();
  }
  osDndService = null;
}

export { OsDndService };
