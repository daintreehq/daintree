// Cross-process protocol for paint-fabric surface views: aux render surfaces
// hosted in sibling WebContentsViews (docs/architecture/terminal-paint-fabric.md,
// Phase 1V substrate). Everything here crosses the renderer↔main boundary, so
// shapes stay concrete and serializable.

// Window-relative rectangle a surface view owns. Electron has no per-pixel
// input pass-through for stacked transparent views, so a surface view must own
// its rectangle exclusively — bounds are the cross-view replacement for DOM
// attach(id, container).
export interface SurfaceViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// The surface-host role rides into the surface view's renderer the same way
// the instance role does (webPreferences.additionalArguments — #10123): the
// value is the surface id, and its presence makes src/main.tsx mount the
// minimal surface-host root instead of the full app shell.
export const SURFACE_HOST_ARG = "--daintree-surface-host=";

// Non-persist partition prefix for surface views. Every surface view MUST get
// a unique partition: Chromium's same-origin process consolidation can
// otherwise collapse N views loading the same app bundle into ONE renderer
// process — silently sharing one 16-WebGL-context budget and one glyph atlas,
// which is the exact invariant view hosting exists to break. No "persist:"
// prefix on purpose: a paint surface has no storage worth persisting.
export const SURFACE_VIEW_PARTITION_PREFIX = "paint-surface";

export function surfaceViewPartition(windowId: number, surfaceId: string, nonce: string): string {
  return `${SURFACE_VIEW_PARTITION_PREFIX}:${windowId}:${surfaceId}:${nonce}`;
}

export interface CreateSurfaceViewResult {
  surfaceId: string;
  // The synthetic pty-host connection id for this surface (the surface view's
  // webContents id). The pty-host keys renderer connections by an opaque
  // numeric id, so a surface view gets its own direct pty-host MessagePort —
  // its own queue and batcher — without any data-plane change.
  webContentsId: number;
  partition: string;
}

export interface SurfaceWebglThresholds {
  surfaceId: string;
  upperThreshold: number;
  lowerThreshold: number;
}

// Tiered crash policy for surface views, mirroring ProjectViewManager: a
// single crash reloads the view; a crash loop stops reloading and retires the
// surface through the compositor (terminals evacuate to siblings — the
// fabric's never-drop-a-terminal fallback). A headless paint surface has no
// use for the project views' recovery page.
export const SURFACE_CRASH_LOOP_WINDOW_MS = 60_000;
export const SURFACE_CRASH_LOOP_THRESHOLD = 3;

export type SurfaceViewCrashDisposition = "reloaded" | "crash-loop";

export interface SurfaceViewCrashReport {
  surfaceId: string;
  disposition: SurfaceViewCrashDisposition;
  reason: string;
  exitCode: number;
}
