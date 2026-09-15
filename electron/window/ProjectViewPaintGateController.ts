/**
 * Paint-gate bridging for ProjectViewManager project switches — the
 * anti-flash mechanism that keeps the outgoing view attached until the
 * incoming view signals it has painted (or a timeout elapses). Extracted
 * from ProjectViewManager (#11004); operates on the manager's shared
 * `pendingPaintGate` state via `host`.
 */

import type { WebContentsView } from "electron";
import type { ProjectViewManager } from "./ProjectViewManager.js";
import type { PaintGate, PaintGateOutcome } from "./ProjectViewManagerTypes.js";

/**
 * Resolve when the renderer with `webContentsId` signals it is ready (via
 * {@link signalViewPainted} and its siblings) — after a confirmed frame when
 * the gate requires one — when the hard timeout elapses, or when a
 * superseding switch cancels the gate. Only one paint gate is tracked at
 * a time — opening a new gate cancels any prior pending one.
 *
 * Two-phase timing:
 *   - Soft (`paintGateTimeoutMs`): fires `onSoftTimeout` for observability.
 *     The gate stays open and the outgoing view stays attached.
 *   - Hard (`paintGateHardTimeoutMs`): resolves the gate as
 *     `"hard-timeout"`. The caller owns the policy: cold starts abandon the
 *     switch and roll back (#11635), warm reactivations fall through and
 *     detach the bridge — once a frame has been confirmed (see below).
 *
 * Frame confirmation (#12394): with `confirmFrame`, a renderer signal no
 * longer releases the gate by itself. Every one of them proves work ran, not
 * that anything was drawn, and detaching the outgoing view over an undrawn
 * incoming one shows a blank canvas. The signal latches readiness, and the
 * gate releases once a probe started after readiness confirms a frame.
 * `deferFrameConfirmation` holds probes until {@link enableFrameConfirmation}
 * (a cold view's load has to settle first). With `unpaintedHardMs`, the hard
 * bound only falls through when some frame has been confirmed; otherwise the
 * gate keeps waiting for a first frame until that bound and resolves
 * `"unpainted"` if none arrives.
 *
 * Both timer values are captured at gate creation. A later
 * `setPaintGateTimeoutMs` / `setPaintGateHardTimeoutMs` call updates the
 * fields but does NOT retime an in-flight gate. The sole exception is
 * {@link retimeSkeletonPaintGateHardTimeout}, an explicit lifecycle call from
 * the switch controller that restarts the hard timer on a value captured
 * before navigation — not a setter-driven retime, so that guarantee holds.
 */
export function waitForPaint(
  host: ProjectViewManager,
  webContentsId: number,
  outgoingView: WebContentsView | null,
  outgoingProjectId: string | null,
  onSoftTimeout?: () => void,
  options?: {
    releaseChannel?: "painted" | "warm-painted" | "skeleton-painted";
    softMs?: number;
    hardMs?: number;
    confirmFrame?: () => Promise<boolean>;
    deferFrameConfirmation?: boolean;
    unpaintedHardMs?: number;
  }
): Promise<PaintGateOutcome> {
  // Cancel any prior gate from a previous switch attempt. Should not
  // normally occur (switchChain serializes), but guards against re-entry
  // from rollback paths.
  clearPaintGate(host);

  const releaseChannel = options?.releaseChannel ?? "painted";
  const softMs = options?.softMs ?? host.paintGateTimeoutMs;
  // Guarantee hard >= soft at gate-creation time so the soft callback
  // always fires before the hard fall-through, regardless of how the two
  // setters are ordered by the resource-profile push.
  const hardMs = Math.max(options?.hardMs ?? host.paintGateHardTimeoutMs, softMs);
  const confirmFrame = options?.confirmFrame;
  const unpaintedHardMs =
    confirmFrame && options?.unpaintedHardMs !== undefined
      ? Math.max(options.unpaintedHardMs, hardMs)
      : undefined;

  return new Promise<PaintGateOutcome>((resolveOuter) => {
    let settled = false;
    const gate: PaintGate = {
      webContentsId,
      releaseChannel,
      outgoingView,
      outgoingProjectId,
      frame: confirmFrame
        ? {
            confirm: confirmFrame,
            enabled: false,
            ready: false,
            painted: false,
            readyProbeStarted: false,
            awaitingFirstFrame: false,
            generation: 0,
          }
        : null,
      softTimeout: setTimeout(() => {
        // Soft tail: log only. Keep waiting for either the paint signal
        // or the hard timeout — DO NOT resolve.
        if (host.pendingPaintGate !== gate) return;
        try {
          onSoftTimeout?.();
        } catch (err) {
          console.error("[ProjectViewManager] paint-gate soft callback threw:", err);
        }
      }, softMs),
      hardTimeout: setTimeout(() => {
        const frame = gate.frame;
        if (frame && unpaintedHardMs !== undefined && !frame.painted) {
          // No frame confirmed yet, so falling through would reveal a blank
          // canvas. Keep the outgoing view up and give the view until the
          // unpainted bound (measured from arm) to draw anything at all.
          frame.awaitingFirstFrame = true;
          gate.hardTimeout = setTimeout(() => {
            gate.resolve("unpainted");
          }, unpaintedHardMs - hardMs);
          return;
        }
        gate.resolve("hard-timeout");
      }, hardMs),
      resolve: (reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(gate.softTimeout);
        clearTimeout(gate.hardTimeout);
        if (host.pendingPaintGate === gate) {
          host.pendingPaintGate = null;
        }
        resolveOuter(reason);
      },
    };
    host.pendingPaintGate = gate;
    if (gate.frame && !options?.deferFrameConfirmation) {
      startFrameConfirmation(host, gate);
    }
  });
}

/**
 * Probe for a drawn frame on `gate`'s view. `releaseOnConfirm` probes were
 * started after readiness, so their frame is the one to reveal; the rest only
 * record that the view is drawing, which lets an expired hard bound fall
 * through without revealing a blank canvas. Settles are guarded on gate
 * identity, so a probe that outlives its gate is inert.
 */
function probeFrame(host: ProjectViewManager, gate: PaintGate, releaseOnConfirm: boolean): void {
  const frame = gate.frame;
  if (!frame) return;
  const generation = frame.generation;
  void frame.confirm().then((confirmed) => {
    if (!confirmed || host.pendingPaintGate !== gate) return;
    if (frame.generation !== generation) return;
    frame.painted = true;
    if (releaseOnConfirm) {
      gate.resolve("signal");
    } else if (frame.awaitingFirstFrame) {
      gate.resolve("hard-timeout");
    }
  });
}

function startFrameConfirmation(host: ProjectViewManager, gate: PaintGate): void {
  const frame = gate.frame;
  if (!frame || frame.enabled) return;
  frame.enabled = true;
  if (frame.ready) {
    frame.readyProbeStarted = true;
    probeFrame(host, gate, true);
  } else {
    probeFrame(host, gate, false);
  }
}

/**
 * Settle a matching gate's readiness. A gate without frame confirmation
 * releases immediately (the original contract); one with it starts the single
 * post-readiness probe once probes are enabled.
 */
function markReady(host: ProjectViewManager, gate: PaintGate): void {
  const frame = gate.frame;
  if (!frame) {
    gate.resolve("signal");
    return;
  }
  frame.ready = true;
  if (!frame.enabled || frame.readyProbeStarted) return;
  frame.readyProbeStarted = true;
  probeFrame(host, gate, true);
}

/**
 * Let a deferred frame-confirmation gate start probing. Called once by the
 * switch controller after a cold view's load settles: before that the view is
 * still navigating, and its skeleton CSS may not be applied yet, so a frame
 * drawn then is not the frame the reveal needs. Guarded on gate identity like
 * {@link signalSkeletonPainted}; returns whether probing was enabled.
 */
export function enableFrameConfirmation(host: ProjectViewManager, webContentsId: number): boolean {
  const gate = host.pendingPaintGate;
  if (!gate?.frame) return false;
  if (gate.webContentsId !== webContentsId) return false;
  if (gate.frame.enabled) return false;
  startFrameConfirmation(host, gate);
  return true;
}

/**
 * Discard what an open frame-confirmed gate has learned about its view: the
 * confirmed frame and the readiness it latched. Called when the incoming
 * renderer goes away mid-gate (#12394) — the frame and the wake belonged to a
 * document that no longer exists, and a warm hard bound that trusted them
 * would detach the outgoing view over the replacement document. Probes still
 * out against the old document are ignored; the gate then needs fresh
 * readiness and a fresh frame, or it runs to its unpainted bound.
 */
export function discardFrameEvidence(host: ProjectViewManager, webContentsId: number): void {
  const gate = host.pendingPaintGate;
  if (!gate?.frame || gate.webContentsId !== webContentsId) return;
  const frame = gate.frame;
  frame.generation += 1;
  frame.painted = false;
  frame.ready = false;
  frame.readyProbeStarted = false;
}

/**
 * Restart an open cold-start skeleton gate's hard timer from now, for `hardMs`.
 * Called once by the switch controller when `loadView()` resolves.
 *
 * The gate is armed before navigation starts (so a signal landing on the same
 * tick as `did-finish-load` is captured rather than dropped), which means its
 * bound would otherwise be spent on renderer spawn, preload eval and the load
 * itself — and a slow-but-legitimate cold load expired it mid-flight, losing
 * the switch to a rollback and an error toast (#11765). The switch controller
 * arms it wide enough to outlast the load's own fatal ceiling and tightens it
 * back to the paint bound here, so "never painted" is measured from the moment
 * the document was verified rather than from before it was even requested.
 *
 * Returns whether the retime happened. `false` is normal and expected: a
 * superseding switch may have cancelled the gate, and suites that stub
 * `waitForPaint` out have no gate at all. Guarded on gate identity exactly
 * like {@link signalSkeletonPainted}, so a late call from a switch that has
 * already been superseded can never retime the gate that replaced it.
 */
export function retimeSkeletonPaintGateHardTimeout(
  host: ProjectViewManager,
  webContentsId: number,
  hardMs: number
): boolean {
  const gate = host.pendingPaintGate;
  if (!gate) return false;
  if (gate.releaseChannel !== "skeleton-painted") return false;
  if (gate.webContentsId !== webContentsId) return false;
  // Cleared before reassigning: overwriting the handle first would drop the
  // only reference that can cancel the provisional timer, leaving it to fire
  // later against a gate `resolve` has since settled.
  clearTimeout(gate.hardTimeout);
  gate.hardTimeout = setTimeout(() => {
    gate.resolve("hard-timeout");
  }, hardMs);
  return true;
}

export function clearPaintGate(host: ProjectViewManager): void {
  const gate = host.pendingPaintGate;
  if (!gate) return;
  gate.resolve("cancelled");
}

/**
 * Renderer-driven gate readiness. Called from the `APP_VIEW_PAINTED` IPC
 * handler with the webContentsId of the renderer that just painted. Settles a
 * cold `"painted"` gate and ALSO a `"skeleton-painted"` early-reveal gate:
 * React having committed its first frame is a strict superset of the skeleton
 * having parsed, so this is the fallback that still releases the bridge if the
 * one-shot `APP_SKELETON_PARSED` was somehow missed (degrading to today's
 * behaviour, never worse). Warm gates own a distinct re-fireable channel and
 * are left for `signalWarmViewPainted`. A mismatch (e.g. a signal arriving
 * after a superseding switch already moved on) is silently ignored.
 */
export function signalViewPainted(host: ProjectViewManager, webContentsId: number): void {
  const gate = host.pendingPaintGate;
  if (!gate) return;
  if (gate.releaseChannel === "warm-painted") return;
  if (gate.webContentsId !== webContentsId) return;
  markReady(host, gate);
}

/**
 * Early-reveal gate readiness. Called when an incoming cold-start view's
 * `APP_SKELETON_PARSED` fires — i.e. its themed first-paint skeleton
 * (`#startup-skeleton`) is in the DOM, well before React mounts. Revealing on
 * the skeleton lets the outgoing view detach without holding the old project
 * on screen for the full ~1.5–4s React cold boot. Parsed is not painted,
 * though: the release still waits for the load to settle and a confirmed
 * frame (#12394). Only settles a gate explicitly armed for the skeleton
 * channel; a stray signal arriving with a cold `"painted"` or warm gate
 * pending (or no gate) is ignored, so the scoped renderer fire is a safe
 * no-op when main isn't bridging an early reveal.
 */
export function signalSkeletonPainted(host: ProjectViewManager, webContentsId: number): void {
  const gate = host.pendingPaintGate;
  if (!gate) return;
  if (gate.releaseChannel !== "skeleton-painted") return;
  if (gate.webContentsId !== webContentsId) return;
  markReady(host, gate);
}

/**
 * Warm-reactivation gate readiness. Called from the `APP_VIEW_WARM_PAINTED`
 * IPC handler after a cached view's wake fan-out completes (#9679). The
 * renderer sends it without waiting on a frame, so the switch controller arms
 * the warm gate with frame confirmation and the release follows a drawn frame
 * (#12394). Only settles a gate that is actually waiting on the warm channel —
 * a warm signal arriving with a cold-start gate pending (or no gate at all) is
 * silently ignored, so the unconditional renderer-side fire is a safe no-op
 * when main isn't bridging.
 */
export function signalWarmViewPainted(host: ProjectViewManager, webContentsId: number): void {
  const gate = host.pendingPaintGate;
  if (!gate) return;
  if (gate.releaseChannel !== "warm-painted") return;
  if (gate.webContentsId !== webContentsId) return;
  markReady(host, gate);
}
