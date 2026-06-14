import type { TerminalActivityPayload } from "@shared/types";
import type { PersistableFlowStatus } from "@shared/types";
import { usePanelStore } from "@/store/panelStore";
import { deriveRuntimeStatus } from "@/store/slices/panelRegistry/helpers";
import { isPtyPanel } from "@shared/types/panel";

// Shared RAF-flushed buffer for high-frequency panel-status writes. Listeners
// in src/store/listeners/panel/ (activity, lifecycle onStatus) enqueue patches
// here instead of calling the per-call setState methods on usePanelStore. One
// shared rAF coalesces all enqueued patches into a single setState — collapsing
// N subscriber notifications per frame into 1, which is the dominant perf win
// because Zustand 5 fires its notify loop synchronously per setState call.
//
// Agent-state writes from `identity.ts` deliberately stay direct (not routed
// through this buffer): processQueue reads live store state on the same tick
// as the write, so deferring the write by a frame would break dispatch
// ordering. See issue #8589 for the perf-vs-correctness trade-off.

// `timestamp` is deliberately excluded: nothing reads it from the panel, and
// folding it into the patch would defeat the no-op short-circuit below — a
// re-delivered activity event with identical visible fields always carries a
// fresh emit-time timestamp.
type ActivityPatch = Pick<TerminalActivityPayload, "headline" | "status" | "type" | "lastCommand">;

interface FlowStatusPatch {
  status: PersistableFlowStatus;
  timestamp: number;
}

/**
 * Held-duration gauge patch. `null` clears the value (terminal no longer
 * paused); a number sets it. A `null` patch always wins within a single
 * frame so a fresh "no longer paused" signal isn't clobbered by a stale
 * non-null patch from the same flush.
 */
interface HeldDurationPatch {
  heldDurationMs: number | null;
}

const activityBuffer = new Map<string, ActivityPatch>();
const flowStatusBuffer = new Map<string, FlowStatusPatch>();
const heldDurationBuffer = new Map<string, HeldDurationPatch>();
let rafId: number | null = null;

function schedule(): void {
  if (rafId !== null) return;
  if (typeof requestAnimationFrame === "undefined") {
    // Non-DOM environments (some test contexts) — flush synchronously to keep
    // semantics observable without a polyfill.
    flushPanelStatusBuffer();
    return;
  }
  rafId = requestAnimationFrame(flushPanelStatusBuffer);
}

export function enqueueActivityUpdate(
  terminalId: string,
  headline: string,
  status: TerminalActivityPayload["status"],
  type: TerminalActivityPayload["type"],
  lastCommand: string | undefined
): void {
  activityBuffer.set(terminalId, { headline, status, type, lastCommand });
  schedule();
}

export function enqueueFlowStatusUpdate(
  terminalId: string,
  status: PersistableFlowStatus,
  timestamp: number
): void {
  // Guard against in-buffer reordering: IPC can deliver events out of
  // chronological order within a single frame (backpressure, multi-source
  // emission, reconnect). Without this guard, a later-arriving `t=100`
  // event would clobber an in-buffer `t=200` event and then pass the
  // fold's persisted-store guard because nothing else has been committed
  // yet for this terminal.
  const existing = flowStatusBuffer.get(terminalId);
  if (existing && timestamp < existing.timestamp) return;
  flowStatusBuffer.set(terminalId, { status, timestamp });
  schedule();
}

/**
 * Set the held-duration gauge for a currently-paused terminal. Sampled
 * by the host's `pause-duration-gauge` reliability metric on each 2s
 * tick; consumers should expect the value to grow monotonically while
 * paused and to clear shortly after `pause-end`.
 */
export function enqueueHeldDurationUpdate(terminalId: string, heldDurationMs: number): void {
  // Non-null patches do not clobber a pending null for the same terminal —
  // a `null` from a fresh tick (terminal no longer in the gauge) wins
  // because the host has already stopped emitting it. Without this guard
  // a stale non-null entry from a previous tick could resurrect a value
  // for a terminal that's already resumed.
  const existing = heldDurationBuffer.get(terminalId);
  if (existing?.heldDurationMs === null) return;
  heldDurationBuffer.set(terminalId, { heldDurationMs });
  schedule();
}

/**
 * Clear the held-duration gauge for a terminal that is no longer paused.
 * Safe to call when no gauge is set — the no-op is a fast path. Schedules
 * a flush if needed.
 */
export function clearHeldDuration(terminalId: string): void {
  const existing = heldDurationBuffer.get(terminalId);
  if (existing?.heldDurationMs === null) return;
  heldDurationBuffer.set(terminalId, { heldDurationMs: null });
  schedule();
}

export function flushPanelStatusBuffer(): void {
  rafId = null;
  if (activityBuffer.size === 0 && flowStatusBuffer.size === 0 && heldDurationBuffer.size === 0) {
    return;
  }

  // Snapshot and clear before the setState updater runs. Clearing first lets
  // re-entrant enqueues during subscriber callbacks land in a fresh frame
  // rather than being silently dropped by a later iteration of this fold.
  const activity = activityBuffer.size > 0 ? new Map(activityBuffer) : null;
  const flow = flowStatusBuffer.size > 0 ? new Map(flowStatusBuffer) : null;
  const held = heldDurationBuffer.size > 0 ? new Map(heldDurationBuffer) : null;
  activityBuffer.clear();
  flowStatusBuffer.clear();
  heldDurationBuffer.clear();

  usePanelStore.setState((state) => {
    const nextById = { ...state.panelsById };
    let changed = false;

    if (activity) {
      for (const [id, patch] of activity) {
        const terminal = nextById[id];
        if (!terminal || !isPtyPanel(terminal)) continue;
        if (
          terminal.activityHeadline === patch.headline &&
          terminal.activityStatus === patch.status &&
          terminal.activityType === patch.type &&
          terminal.lastCommand === patch.lastCommand
        ) {
          continue;
        }
        nextById[id] = {
          ...terminal,
          activityHeadline: patch.headline,
          activityStatus: patch.status,
          activityType: patch.type,
          lastCommand: patch.lastCommand,
        };
        changed = true;
      }
    }

    if (flow) {
      for (const [id, patch] of flow) {
        const terminal = nextById[id];
        if (!terminal || !isPtyPanel(terminal)) continue;

        // A late flow event for a terminal that has already exited must not
        // revive the "paused" pill. `deriveRuntimeStatus` already pins
        // runtimeStatus at "exited", but flowStatus drives the header pill
        // directly, so guard the write here too (#9899).
        if (terminal.runtimeStatus === "exited") continue;

        const prevTs = terminal.flowStatusTimestamp;
        if (prevTs !== undefined && patch.timestamp < prevTs) continue;

        if (
          terminal.flowStatus === patch.status &&
          terminal.flowStatusTimestamp === patch.timestamp
        ) {
          continue;
        }

        const runtimeStatus = deriveRuntimeStatus(
          terminal.isVisible,
          patch.status,
          terminal.runtimeStatus
        );

        nextById[id] = {
          ...terminal,
          flowStatus: patch.status,
          flowStatusTimestamp: patch.timestamp,
          runtimeStatus,
        };
        changed = true;
      }
    }

    if (held) {
      for (const [id, patch] of held) {
        const terminal = nextById[id];
        if (!terminal || !isPtyPanel(terminal)) continue;
        if (terminal.heldDurationMs === patch.heldDurationMs) continue;
        nextById[id] = {
          ...terminal,
          // `null` clears the field via destructuring-rest; a number sets it.
          ...(patch.heldDurationMs === null
            ? { heldDurationMs: undefined }
            : { heldDurationMs: patch.heldDurationMs }),
        };
        changed = true;
      }
    }

    if (!changed) return state;
    return { panelsById: nextById };
  });
}

export function cancelPanelStatusBuffer(): void {
  if (rafId !== null && typeof cancelAnimationFrame !== "undefined") {
    cancelAnimationFrame(rafId);
  }
  rafId = null;
  activityBuffer.clear();
  flowStatusBuffer.clear();
  heldDurationBuffer.clear();
}

/**
 * Drop a single terminal's pending flow-status and held-duration patches
 * without touching the shared RAF or other terminals' buffers. Called when a
 * terminal exits: a flow-status patch enqueued earlier in the same frame would
 * otherwise survive the flush and resurrect a stale "paused" state on the
 * just-exited panel — the fold's timestamp guard can't catch it because exit
 * clears `flowStatusTimestamp` to `undefined`, defeating the `< prevTs` check.
 * Activity patches are left intact; they don't drive the paused pill.
 */
export function cancelTerminalFlowState(terminalId: string): void {
  flowStatusBuffer.delete(terminalId);
  heldDurationBuffer.delete(terminalId);
}
