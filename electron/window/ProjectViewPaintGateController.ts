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
 * Resolve when the renderer with `webContentsId` posts `APP_VIEW_PAINTED`
 * via {@link signalViewPainted}, when the hard timeout elapses, or when a
 * superseding switch cancels the gate. Only one paint gate is tracked at
 * a time — opening a new gate cancels any prior pending one.
 *
 * Two-phase timing:
 *   - Soft (`paintGateTimeoutMs`): fires `onSoftTimeout` for observability.
 *     The gate stays open and the outgoing view stays attached.
 *   - Hard (`paintGateHardTimeoutMs`): resolves the gate as
 *     `"hard-timeout"`, prompting the caller to detach the outgoing view.
 *
 * Both timer values are captured at gate creation. A later
 * `setPaintGateTimeoutMs` / `setPaintGateHardTimeoutMs` call updates the
 * fields but does NOT retime an in-flight gate.
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

  return new Promise<PaintGateOutcome>((resolveOuter) => {
    let settled = false;
    const gate: PaintGate = {
      webContentsId,
      releaseChannel,
      outgoingView,
      outgoingProjectId,
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
  });
}

export function clearPaintGate(host: ProjectViewManager): void {
  const gate = host.pendingPaintGate;
  if (!gate) return;
  gate.resolve("cancelled");
}

/**
 * Renderer-driven gate release. Called from the `APP_VIEW_PAINTED` IPC
 * handler with the webContentsId of the renderer that just painted. Releases
 * a cold `"painted"` gate and ALSO a `"skeleton-painted"` early-reveal gate:
 * React having committed its first frame is a strict superset of the skeleton
 * having parsed, so this is the fallback that still detaches the bridge if the
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
  gate.resolve("signal");
}

/**
 * Early-reveal gate release. Called when an incoming cold-start view's
 * `APP_SKELETON_PARSED` fires — i.e. its themed first-paint skeleton
 * (`#startup-skeleton`, injected in `createView`) is in the DOM, well before
 * React mounts. Releasing here lets the outgoing view detach and the branded
 * skeleton show in hundreds of ms instead of holding the old project on
 * screen for the full ~1.5–4s React cold boot. The skeleton is an opaque
 * themed cover over the view's themed canvas background, so the anti-flash
 * guarantee (no blank-canvas frame) is preserved. Only releases a gate
 * explicitly armed for the skeleton channel; a stray signal arriving with a
 * cold `"painted"` or warm gate pending (or no gate) is ignored, so the
 * scoped renderer fire is a safe no-op when main isn't bridging an early
 * reveal.
 */
export function signalSkeletonPainted(host: ProjectViewManager, webContentsId: number): void {
  const gate = host.pendingPaintGate;
  if (!gate) return;
  if (gate.releaseChannel !== "skeleton-painted") return;
  if (gate.webContentsId !== webContentsId) return;
  gate.resolve("signal");
}

/**
 * Warm-reactivation gate release. Called from the `APP_VIEW_WARM_PAINTED` IPC
 * handler after a cached view's wake fan-out completes and a clean
 * post-atlas-repair frame paints (#9679). Only releases a gate that is
 * actually waiting on the warm channel — a warm signal arriving with a
 * cold-start gate pending (or no gate at all) is silently ignored, so the
 * unconditional renderer-side fire is a safe no-op when main isn't bridging.
 */
export function signalWarmViewPainted(host: ProjectViewManager, webContentsId: number): void {
  const gate = host.pendingPaintGate;
  if (!gate) return;
  if (gate.releaseChannel !== "warm-painted") return;
  if (gate.webContentsId !== webContentsId) return;
  gate.resolve("signal");
}
