import type { WorkspaceHostEvent } from "../../shared/types/workspace-host.js";
import type { Worktree, WslGitEligibility } from "../../shared/types/worktree.js";
import { detectWslPath, getDefaultWslDistro } from "../utils/wsl.js";

export interface WslGitOptIn {
  enabled: boolean;
  dismissed: boolean;
}

/** The slice of `WorktreeMonitor` the tracker reads and drives. */
export interface WslTrackedMonitor {
  readonly isWslPath: boolean;
  readonly wslDistro: string | undefined;
  setWslEligible(eligibility: WslGitEligibility): void;
  setWslOptIn(enabled: boolean, dismissed: boolean): void;
}

export interface WslGitEligibilityHost {
  /** True while the host is backgrounded; the distro poll must not arm. */
  readonly backgrounded: boolean;
  readonly monitors: ReadonlyMap<string, WslTrackedMonitor>;
  sendEvent(event: Extract<WorkspaceHostEvent, { type: "clear-wsl-git-opt-in" }>): void;
}

/** How often to re-check the WSL default distro (Windows only). */
const WSL_DISTRO_POLL_INTERVAL_MS = 60_000;

function normalizePathKeyForPrefix(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized === "" && value.startsWith("/") ? "/" : normalized;
}

function pathParentForPrefix(value: string): string {
  const normalized = normalizePathKeyForPrefix(value);
  if (normalized === "/") return "/";
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex <= 0) return slashIndex === 0 ? "/" : normalized;
  return normalized.slice(0, slashIndex);
}

function isPathKeyAtOrUnder(candidate: string, parent: string): boolean {
  const normalizedCandidate = normalizePathKeyForPrefix(candidate);
  const normalizedParent = normalizePathKeyForPrefix(parent);
  const comparableCandidate =
    process.platform === "win32" ? normalizedCandidate.toLowerCase() : normalizedCandidate;
  const comparableParent =
    process.platform === "win32" ? normalizedParent.toLowerCase() : normalizedParent;

  return (
    comparableCandidate === comparableParent ||
    comparableCandidate.startsWith(comparableParent === "/" ? "/" : `${comparableParent}/`)
  );
}

/**
 * Compute three-state WSL git eligibility for a worktree distro against the
 * current default distro. `null` default (probe failed / WSL absent) maps to
 * `'unprobed'` rather than `'ineligible'` so the renderer can offer a
 * re-check instead of a wrong "git runs via Windows" note. UNC paths are
 * case-insensitive on Windows and `wsl --list --verbose` returns canonical
 * case (e.g. "Ubuntu"), so compare case-insensitively.
 */
function computeWslEligibility(
  distro: string | undefined,
  defaultDistro: string | null
): WslGitEligibility {
  if (!distro || defaultDistro === null) return "unprobed";
  return defaultDistro.toLowerCase() === distro.toLowerCase() ? "eligible" : "ineligible";
}

/**
 * Owns the Windows WSL git-eligibility lifecycle for one workspace host:
 * per-worktree opt-in state, the cached default-distro probe, the background
 * default-distro poll and its stale-probe guard, and pruning of opt-in entries
 * for worktrees that no longer exist.
 */
export class WslGitEligibilityTracker {
  /** Per-worktree WSL git opt-in state forwarded from main on load and toggle. */
  private optIns: Record<string, WslGitOptIn> = {};
  /** Cached default WSL distro (populated lazily on first WSL-path detection). */
  private defaultDistroPromise: Promise<string | null> | null = null;
  /**
   * Last default distro the poller observed. `undefined` until the first probe
   * seeds it (so the first poll tick can't spuriously diff against it). `null`
   * means the probe ran but found no default (WSL absent / probe failed).
   */
  private lastKnownDefaultDistro: string | null | undefined = undefined;
  /** Background poll handle that watches for WSL default-distro changes. */
  private poller: ReturnType<typeof setInterval> | null = null;
  // Stopped by `pause()` rather than by an unload, so `resume()` restarts it.
  private pollerSuspended = false;
  /**
   * Monotonic guard so a slow probe (poll or reprobe) that resolves after a
   * newer probe — or after a project switch — discards its stale result instead
   * of overwriting fresher state or refreshing the next project's monitors.
   */
  private probeSeq = 0;

  constructor(private readonly host: WslGitEligibilityHost) {}

  /**
   * Merge the persisted opt-in map main ships on `load-project`. Merge instead
   * of replacing: a `set-wsl-opt-in` message arriving during the load's async
   * work would otherwise be silently overwritten. The most recent in-memory
   * value wins on conflict.
   */
  mergePersistedOptIns(persisted: Record<string, WslGitOptIn>): void {
    this.optIns = { ...persisted, ...this.optIns };
  }

  /**
   * Detect whether a worktree is mounted via WSL and, if so, attach the
   * detection metadata + persisted opt-in state. No-op on non-Windows. Bind
   * time only — the result is folded into the `Worktree` passed to
   * `WorktreeMonitor`.
   */
  async enrichWorktree(wt: Worktree): Promise<Worktree> {
    if (process.platform !== "win32") return wt;
    const detected = detectWslPath(wt.path);
    if (!detected) return wt;

    if (!this.defaultDistroPromise) {
      this.defaultDistroPromise = getDefaultWslDistro().catch(() => null);
    }
    const defaultDistro = await this.defaultDistroPromise;
    // Seed the poller's baseline from the first resolved probe so its first
    // tick compares against a real value (no spurious refresh on a stable box).
    this.lastKnownDefaultDistro = defaultDistro;
    // Now that we know a WSL worktree exists, arm the background distro watcher
    // (idempotent — only the first WSL worktree actually starts the interval).
    this.startPoller();
    const eligibility = computeWslEligibility(detected.distro, defaultDistro);
    const persisted = this.optIns[wt.id];

    return {
      ...wt,
      isWslPath: true,
      wslDistro: detected.distro,
      wslPosixPath: detected.posixPath,
      wslGitEligible: eligibility,
      wslGitOptIn: Boolean(persisted?.enabled),
      wslGitDismissed: Boolean(persisted?.dismissed),
    };
  }

  /**
   * Re-probe the WSL default distro on demand (renderer "Re-check" button) and
   * refresh all WSL monitors. Sets the target monitor to `'unprobed'` first so
   * the banner shows a pending state while the probe runs. The probe is shared
   * across all worktrees, so we refresh every WSL monitor, not just the target.
   */
  async reprobe(worktreeId: string): Promise<void> {
    if (process.platform !== "win32") return;
    const monitor = this.host.monitors.get(worktreeId);
    if (!monitor || !monitor.isWslPath) return;
    monitor.setWslEligible("unprobed");
    const { distro, current } = await this.probeDefaultDistro();
    if (!current) return;
    this.applyDefaultDistro(distro);
  }

  /**
   * Update WSL git routing state for a single worktree. Persists the new
   * preference into the in-memory map and forwards to the matching monitor
   * (which re-emits its snapshot).
   */
  setOptIn(worktreeId: string, enabled: boolean, dismissed: boolean): void {
    this.optIns[worktreeId] = { enabled, dismissed };
    const monitor = this.host.monitors.get(worktreeId);
    if (monitor) {
      monitor.setWslOptIn(enabled, dismissed);
    }
  }

  /**
   * Drop the in-memory opt-in entry for a removed worktree and tell main to
   * drop the persistent one. Idempotent on the main side: `clearWslGitEntry`
   * is a no-op if the key is missing, and does a case-insensitive lookup
   * on win32 to handle legacy mixed-case persisted keys.
   */
  forgetWorktree(worktreeId: string): void {
    if (!Object.prototype.hasOwnProperty.call(this.optIns, worktreeId)) return;
    delete this.optIns[worktreeId];
    this.host.sendEvent({
      type: "clear-wsl-git-opt-in",
      worktreeId,
    });
  }

  /**
   * Bulk self-heal of the opt-in map after `loadProject` lands the live
   * worktree set (#9926, review #1). Walks the in-memory mirror and emits
   * one `clear-wsl-git-opt-in` per key that (a) is not in the live set AND
   * (b) is rooted under this project's parent directory. Foreign-project
   * keys are left in the in-memory mirror for the duration of this load
   * and never reach main — otherwise loading project A would silently
   * erase project B's valid opt-ins from the global persisted map on every
   * load/prewarm/host-restart. The next load of the owning project picks
   * the foreign keys up and prunes them on that cycle.
   */
  pruneStale(worktrees: readonly Worktree[], projectRootPath: string | null): void {
    const projectParent = projectRootPath ? pathParentForPrefix(projectRootPath) : null;
    const projectRoot = projectRootPath ? normalizePathKeyForPrefix(projectRootPath) : null;
    const liveIds = new Set(worktrees.map((wt) => wt.id));
    for (const key of Object.keys(this.optIns)) {
      if (liveIds.has(key)) continue;
      if (
        projectParent &&
        normalizePathKeyForPrefix(key) !== projectRoot &&
        !isPathKeyAtOrUnder(key, projectParent)
      ) {
        continue;
      }
      delete this.optIns[key];
      this.host.sendEvent({
        type: "clear-wsl-git-opt-in",
        worktreeId: key,
      });
    }
  }

  /** Stop a running distro poll for a backgrounded host; `resume()` re-arms it. */
  pause(): void {
    if (this.poller) {
      this.stop();
      this.pollerSuspended = true;
    }
  }

  /** Re-arm a distro poll that `pause()` (or a backgrounded first enrichment) held back. */
  resume(): void {
    if (this.pollerSuspended) {
      this.pollerSuspended = false;
      this.startPoller();
    }
  }

  /** Stop the WSL distro watcher (project switch / dispose). */
  stop(): void {
    // Bump the sequence so any in-flight probe (poll or reprobe) sees itself
    // superseded and bails before mutating state — otherwise a probe awaiting
    // across a project switch could refresh the next project's monitors with
    // this project's distro.
    this.probeSeq++;
    this.pollerSuspended = false;
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
  }

  /**
   * Stop the poll and drop the cached default-distro probe so the next project
   * probes afresh. Opt-ins survive: main's persisted map spans every project.
   */
  resetForProjectSwitch(): void {
    this.stop();
    this.defaultDistroPromise = null;
    this.lastKnownDefaultDistro = undefined;
  }

  /**
   * Arm the Windows-only background watcher that re-checks the WSL default
   * distro. The default distro can change mid-session (`wsl --set-default`,
   * install/uninstall) and the renderer has no OS event to subscribe to, so we
   * poll. Idempotent — a second call while already running is a no-op.
   */
  private startPoller(): void {
    if (process.platform !== "win32") return;
    if (this.poller) return;
    // A first WSL enrichment can finish after the host was backgrounded; arm
    // on the way back to the foreground instead.
    if (this.host.backgrounded) {
      this.pollerSuspended = true;
      return;
    }
    this.poller = setInterval(() => {
      void this.pollDefaultDistro();
    }, WSL_DISTRO_POLL_INTERVAL_MS);
    // Don't keep the host process alive solely for this poll.
    this.poller.unref?.();
  }

  /**
   * Probe the default distro under a sequence guard. Returns whether this probe
   * is still the most recent one — a later probe (concurrent reprobe, or a
   * project switch via `stop`) supersedes an earlier one so the stale result is
   * discarded rather than overwriting fresher state.
   */
  private async probeDefaultDistro(): Promise<{ distro: string | null; current: boolean }> {
    const seq = ++this.probeSeq;
    const distro = await getDefaultWslDistro().catch(() => null);
    return { distro, current: seq === this.probeSeq };
  }

  /** Commit a fresh probe result to the cache and fan it out to all monitors. */
  private applyDefaultDistro(distro: string | null): void {
    this.lastKnownDefaultDistro = distro;
    this.defaultDistroPromise = Promise.resolve(distro);
    this.refreshAllMonitors(distro);
  }

  /**
   * One poll tick: re-probe the default distro and, when it changed, invalidate
   * the cache and refresh every WSL monitor's eligibility so existing worktrees
   * stop using a stale decision.
   */
  private async pollDefaultDistro(): Promise<void> {
    const { distro, current } = await this.probeDefaultDistro();
    if (!current) return;
    if (distro === this.lastKnownDefaultDistro) return;
    this.applyDefaultDistro(distro);
  }

  /**
   * Recompute and push WSL git eligibility to every active WSL monitor against
   * the given default distro. Non-WSL monitors are skipped.
   */
  private refreshAllMonitors(defaultDistro: string | null): void {
    for (const monitor of this.host.monitors.values()) {
      if (!monitor.isWslPath) continue;
      monitor.setWslEligible(computeWslEligibility(monitor.wslDistro, defaultDistro));
    }
  }
}
