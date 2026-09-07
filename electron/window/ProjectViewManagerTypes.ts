/**
 * Shared internal types for the ProjectViewManager module family
 * (electron/window/ProjectView*.ts). Not part of the public API — only
 * ViewInventoryEntry and ProjectViewManagerOptions (declared in
 * ProjectViewManager.ts) are exported for consumers.
 */

import type { WebContentsView } from "electron";
import type { ProjectSwitchTrace } from "../../shared/types/ipc/project.js";

export type ViewState = "loading" | "active" | "cached";

export type PaintGateOutcome = "signal" | "hard-timeout" | "cancelled";

export interface PaintGate {
  webContentsId: number;
  /**
   * Which renderer signal releases this gate. Cold-start gates normally wait on
   * the one-shot `APP_VIEW_PAINTED` (`"painted"`); fast cold switches instead
   * wait on the earlier one-shot `APP_SKELETON_PARSED` (`"skeleton-painted"`)
   * so the themed first-paint skeleton reveals in hundreds of ms rather than
   * after the full React cold boot. Warm-reactivation gates wait on the
   * re-fireable `APP_VIEW_WARM_PAINTED` (`"warm-painted"`), because a cached
   * view's V8 context already fired its one-shot painted signal on first load
   * and will never re-emit it (#9679). The discriminator keeps a stray signal of
   * the wrong kind from releasing the bridge early; `signalViewPainted` also
   * releases a `"skeleton-painted"` gate as a fallback (a committed React frame
   * is a strict superset of the skeleton having parsed).
   */
  releaseChannel: "painted" | "warm-painted" | "skeleton-painted";
  /**
   * The view that was visible when the gate opened — still attached during the
   * wait. This may be a registered project view or the unbound welcome view on
   * first-run/project-picker windows. Resize events must reach it too so
   * visible bounds stay in sync.
   */
  outgoingView: WebContentsView | null;
  /**
   * Project id for the outgoing view when it is a registered project view.
   * Unbound welcome views have no project id and are never LRU candidates.
   */
  outgoingProjectId: string | null;
  /**
   * Soft timer — fires `onSoftTimeout` but does NOT resolve the gate. The
   * outgoing view stays attached so the soft tail is invisible to the user.
   */
  softTimeout: ReturnType<typeof setTimeout>;
  /**
   * Hard timer — resolves the gate as `"hard-timeout"`, which hands the
   * decision back to the caller rather than deciding anything itself. The
   * policy is per channel: a warm gate falls through and detaches, a cold one
   * must abandon and roll back BEFORE any detach, or it strands the user on a
   * view that never rendered (#11635). Replaced in place once when a cold
   * skeleton gate is retimed after its load settles (#11765); `resolve` always
   * clears whichever handle is current.
   */
  hardTimeout: ReturnType<typeof setTimeout>;
  /**
   * Settle the gate. Clears both timers, clears `pendingPaintGate`, and
   * resolves the outer promise. Idempotent — repeat calls no-op.
   */
  resolve: (reason: PaintGateOutcome) => void;
}

export type EvictionReason = "lru" | "pressure" | "limit-change";

export interface ViewEntry {
  view: WebContentsView;
  projectId: string;
  projectPath: string;
  lastUsed: number;
  state: ViewState;
  crashTimestamps: number[];
  cleanupHandlers: () => void;
  /**
   * Delayed/periodic CDP memory purge while cached (see schedulePurge).
   * Cleared on activation and teardown so a live view is never purged.
   */
  purgeTimer?: NodeJS.Timeout;
  /**
   * Cold-start preload (`preload.cts`) evaluation cost in ms, self-reported by
   * the view's preload via PERF_FLUSH_RENDERER_MARKS (#9770). Set once per view
   * (first-write); surfaced in the `projectview.revival` log so cache-pressure
   * signals carry the preload cost that was paid when the view cold-started.
   */
  preloadEvalDurationMs?: number;
  /**
   * Perf trace of the switch that most recently activated this view, so the
   * post-swap marks main emits from outside `performSwitch` (PTY port on
   * did-finish-load, first-interactive) can join the same `switchId`.
   */
  switchTrace?: ProjectSwitchTrace;
  /**
   * Cold-start timeline (`performance.now()` values), set by the cold path in
   * `performSwitch` and cleared by the view's first `app:first-interactive` —
   * which is what turns them into the `projectview.coldstart.interactive` log.
   * Absent on warm reactivations and once the view has been interactive.
   */
  coldStartAt?: number;
  loadFinishedAt?: number;
  visibleAt?: number;
}
