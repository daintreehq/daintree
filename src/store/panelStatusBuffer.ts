import type { TerminalActivityPayload } from "@shared/types";
import type { PersistableFlowStatus } from "@shared/types";
import { usePanelStore } from "@/store/panelStore";
import { deriveRuntimeStatus } from "@/store/slices/panelRegistry/helpers";

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

type ActivityPatch = Pick<
  TerminalActivityPayload,
  "headline" | "status" | "type" | "timestamp" | "lastCommand"
>;

interface FlowStatusPatch {
  status: PersistableFlowStatus;
  timestamp: number;
}

const activityBuffer = new Map<string, ActivityPatch>();
const flowStatusBuffer = new Map<string, FlowStatusPatch>();
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
  timestamp: number,
  lastCommand: string | undefined
): void {
  activityBuffer.set(terminalId, { headline, status, type, timestamp, lastCommand });
  schedule();
}

export function enqueueFlowStatusUpdate(
  terminalId: string,
  status: PersistableFlowStatus,
  timestamp: number
): void {
  // Last write wins per terminal per frame. The slice's stale-timestamp guard
  // is reproduced inside the fold against live store state, so accepting the
  // latest enqueued patch here is correct: an older event still in-buffer is
  // already superseded by the newer one we are about to set.
  flowStatusBuffer.set(terminalId, { status, timestamp });
  schedule();
}

export function flushPanelStatusBuffer(): void {
  rafId = null;
  if (activityBuffer.size === 0 && flowStatusBuffer.size === 0) return;

  // Snapshot and clear before the setState updater runs. Clearing first lets
  // re-entrant enqueues during subscriber callbacks land in a fresh frame
  // rather than being silently dropped by a later iteration of this fold.
  const activity = activityBuffer.size > 0 ? new Map(activityBuffer) : null;
  const flow = flowStatusBuffer.size > 0 ? new Map(flowStatusBuffer) : null;
  activityBuffer.clear();
  flowStatusBuffer.clear();

  usePanelStore.setState((state) => {
    const nextById = { ...state.panelsById };
    let changed = false;

    if (activity) {
      for (const [id, patch] of activity) {
        const terminal = nextById[id];
        if (!terminal) continue;
        if (
          terminal.activityHeadline === patch.headline &&
          terminal.activityStatus === patch.status &&
          terminal.activityType === patch.type &&
          terminal.activityTimestamp === patch.timestamp &&
          terminal.lastCommand === patch.lastCommand
        ) {
          continue;
        }
        nextById[id] = {
          ...terminal,
          activityHeadline: patch.headline,
          activityStatus: patch.status,
          activityType: patch.type,
          activityTimestamp: patch.timestamp,
          lastCommand: patch.lastCommand,
        };
        changed = true;
      }
    }

    if (flow) {
      for (const [id, patch] of flow) {
        const terminal = nextById[id];
        if (!terminal) continue;

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
}
