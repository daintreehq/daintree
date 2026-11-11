import { systemPreferences } from "electron";
import { execFile, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";

type StateCallback = (osDndActive: boolean | undefined) => void;

const PROBE_TIMEOUT_MS = 1500;
const PROBE_MAX_BUFFER_BYTES = 16 * 1024;

/**
 * One initialize→dispose lifecycle's initial probe. Its identity is the
 * lifecycle token: a probe callback or notification holding a record that is
 * no longer `this.probe` belongs to a disposed lifecycle and must not write.
 */
interface InitialProbe {
  ready: Promise<void>;
  settle: () => void;
  child: ChildProcess | null;
  /** A live notification arrived, so the in-flight probe result is older. */
  liveStateObserved: boolean;
}

/**
 * OsDndService — surfaces the OS-level Do-Not-Disturb / Focus state to the
 * renderer.
 *
 * @pattern Factory/Accessor Methods (Pattern C)
 *
 * macOS (primary supported platform):
 *   - Initial state probed once, asynchronously, via `plutil` reading
 *     `~/Library/DoNotDisturb/DB/Assertions.json` — a non-empty mode
 *     identifier means a Focus mode (including classic DND) is active. The
 *     probe runs during cold start, so it must never block Main (#16809).
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
 * The state is consumed by the informational-audio gate in
 * `AgentNotificationService` (working pulse and all-clear) and by the
 * read-only DND indicators in the renderer (toolbar button + Notification
 * Center). It must NEVER be used to suppress in-app toasts.
 */
class OsDndService {
  private state: boolean | undefined = undefined;
  private initialized = false;
  private subscriptionIds: number[] = [];
  private listeners = new Set<StateCallback>();
  private probe: InitialProbe | null = null;

  initialize(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    if (process.platform !== "darwin") {
      // No detection available — leave state undefined.
      return;
    }

    let settle!: () => void;
    const ready = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const probe: InitialProbe = { ready, settle, child: null, liveStateObserved: false };
    this.probe = probe;

    // Subscribe before the probe starts so no transition lands in a gap.
    this.subscribe("_NSDoNotDisturbEnabledNotification", probe, true);
    this.subscribe("_NSDoNotDisturbDisabledNotification", probe, false);

    probe.child = startMacOsInitialProbe((active) => {
      probe.child = null;
      if (this.probe === probe && !probe.liveStateObserved) {
        this.applyState(active);
      }
      probe.settle();
    });
  }

  private subscribe(name: string, probe: InitialProbe, next: boolean): void {
    try {
      const id = systemPreferences.subscribeNotification(name, () => {
        if (this.probe !== probe) return;
        probe.liveStateObserved = true;
        this.applyState(next);
      });
      this.subscriptionIds.push(id);
    } catch (err) {
      console.warn(`[OsDndService] Failed to subscribe to ${name}:`, err);
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
   * Current DND state. `undefined` means "unknown" — a platform with no
   * detection, before `initialize()` has run, or while the initial macOS
   * probe is still in flight. Consumers must treat it as "do not gate"; only
   * an explicit `true` suppresses.
   */
  getState(): boolean | undefined {
    return this.state;
  }

  /**
   * Current DND state once the initial macOS probe has settled, for callers
   * that need a probed answer rather than "unknown" (renderer hydration).
   * Resolves `undefined` if the service is disposed while waiting.
   */
  async getStateWhenReady(): Promise<boolean | undefined> {
    const probe = this.probe;
    if (!probe) return this.state;
    await probe.ready;
    return this.probe === probe ? this.state : undefined;
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
    // Invalidate first so neither a late probe callback nor a notification
    // already queued can write into the next lifecycle.
    const probe = this.probe;
    this.probe = null;
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
    if (probe) {
      probe.child?.kill();
      probe.child = null;
      probe.settle();
    }
  }
}

/**
 * macOS initial-state probe. The subscription only fires on transitions, so
 * without this we'd report `undefined` until the user toggled DND. The
 * `Assertions.json` file lists the active Focus-mode assertions; an empty
 * read means no mode is active. Any failure (file missing, plutil exiting
 * non-zero or timing out, sandbox restriction) reports `false` — the common
 * cause is simply that no assertion is set.
 */
function startMacOsInitialProbe(onResult: (active: boolean) => void): ChildProcess | null {
  const assertionsPath = path.join(
    os.homedir(),
    "Library",
    "DoNotDisturb",
    "DB",
    "Assertions.json"
  );
  try {
    return execFile(
      "/usr/bin/plutil",
      [
        "-extract",
        "data.0.storeAssertionRecords.0.assertionDetailsModeIdentifier",
        "raw",
        "-o",
        "-",
        assertionsPath,
      ],
      { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER_BYTES },
      (err, stdout) => {
        onResult(!err && stdout.trim().length > 0);
      }
    );
  } catch {
    onResult(false);
    return null;
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
