import { BrowserWindow, screen } from "electron";
import { windowStatesStore, type WindowStateEntry } from "./store.js";

const LEGACY_KEY = "__legacy__";
const MRU_OFFSET_PX = 30;
// How many cascade steps a new window takes off windows it would land on.
const MAX_CASCADE_STEPS = 10;

// Cap on how many per-project window-state entries `window-states.json` retains.
// Without it the map grows one entry per project ever opened, is never pruned,
// and electron-store re-serializes the whole file on every window move/resize
// (500ms debounce) plus a 60s crash-recovery snapshot. The `__legacy__`
// cold-start fallback is exempt — it never counts toward or is evicted by the cap.
const WINDOW_STATE_MRU_CAP = 50;

interface DebouncedFunction<T extends (...args: unknown[]) => void> {
  (...args: Parameters<T>): void;
  cancel: () => void;
  flush: () => void;
  pending: () => boolean;
}

function debounce<T extends (...args: unknown[]) => void>(
  func: T,
  wait: number
): DebouncedFunction<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: Parameters<T>) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      timeout = null;
      func(...args);
    }, wait);
  };
  debounced.pending = () => timeout !== null;
  debounced.cancel = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
  };
  debounced.flush = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
      func();
    }
  };
  return debounced as DebouncedFunction<T>;
}

type WindowStateBounds = {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
  isFullScreen: boolean;
};

let lastSavedProjectPath: string | null = null;

// Cached on first use — lazy-require of ProjectStore is a one-shot, not a hot-path reload.
let cachedProjectStore: {
  getCurrentProjectId?: () => string | null;
  getProjectById?: (id: string) => { path?: string } | null;
} | null = undefined as unknown as typeof cachedProjectStore;

function getCurrentProjectPath(): string | null {
  try {
    if (cachedProjectStore === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { projectStore } = require("./services/ProjectStore.js");
      cachedProjectStore = projectStore ?? null;
    }
    if (!cachedProjectStore) return null;
    const projectId = cachedProjectStore.getCurrentProjectId?.();
    if (!projectId) return null;
    const project = cachedProjectStore.getProjectById?.(projectId);
    return project?.path ?? null;
  } catch (err) {
    if (cachedProjectStore === undefined) {
      console.warn(
        "[WindowState] ProjectStore failed to load, per-project window state disabled:",
        err
      );
      cachedProjectStore = null;
    }
    return null;
  }
}

function getMruBounds(): WindowStateBounds | null {
  const windowStates = windowStatesStore.get("windowStates") ?? {};

  if (lastSavedProjectPath && windowStates[lastSavedProjectPath]) {
    return { isFullScreen: false, ...windowStates[lastSavedProjectPath] };
  }

  if (windowStates[LEGACY_KEY]) {
    return { isFullScreen: false, ...windowStates[LEGACY_KEY] };
  }

  // Last resort: pick any entry (any saved state gives better defaults than none)
  const keys = Object.keys(windowStates);
  if (keys.length > 0) {
    return { isFullScreen: false, ...windowStates[keys[0]] };
  }

  return null;
}

function clampToDisplay(bounds: { x: number; y: number; width: number; height: number }): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const display = screen.getDisplayMatching(bounds as Electron.Rectangle);
  if (!display) return bounds;
  // Some Wayland/GNOME compositors report a zero-dimension workArea; fall back to
  // the display's full bounds so the clamp math never produces a 0x0 window.
  const safeWorkArea =
    display.workArea.width > 0 && display.workArea.height > 0 ? display.workArea : display.bounds;
  const clampedWidth = Math.round(Math.min(bounds.width, safeWorkArea.width));
  const clampedHeight = Math.round(Math.min(bounds.height, safeWorkArea.height));
  return {
    x: Math.max(
      safeWorkArea.x,
      Math.min(bounds.x, safeWorkArea.x + safeWorkArea.width - clampedWidth)
    ),
    y: Math.max(
      safeWorkArea.y,
      Math.min(bounds.y, safeWorkArea.y + safeWorkArea.height - clampedHeight)
    ),
    width: clampedWidth,
    height: clampedHeight,
  };
}

interface ResolvedWindowBounds extends WindowStateBounds {
  /** The project's own saved bounds, as opposed to ones borrowed from another window. */
  ownSaved: boolean;
}

function resolveWindowBounds(projectPath: string | null | undefined): ResolvedWindowBounds {
  // 1. Try per-project state
  const windowStates = windowStatesStore.get("windowStates") ?? {};
  if (projectPath) {
    if (windowStates[projectPath]) {
      return { isFullScreen: false, ...windowStates[projectPath], ownSaved: true };
    }

    // 2. MRU cascade for new project windows
    const mru = getMruBounds();
    if (mru && mru.x !== undefined && mru.y !== undefined) {
      const offset = clampToDisplay({
        x: (mru.x ?? 0) + MRU_OFFSET_PX,
        y: (mru.y ?? 0) + MRU_OFFSET_PX,
        width: mru.width,
        height: mru.height,
      });
      return {
        ...offset,
        isMaximized: false,
        isFullScreen: false,
        ownSaved: false,
      };
    }
  }

  // 3. Cold-start restore: startup may not know the project path yet, so use
  // the last shell window state exactly (no cascade offset, preserve maximize).
  if (!projectPath) {
    const mru = getMruBounds();
    if (mru) {
      return { ...mru, ownSaved: false };
    }
  }

  // 4. Defaults
  return { width: 1200, height: 800, isMaximized: false, isFullScreen: false, ownSaved: false };
}

/**
 * Whether a window placed at `bounds` would sit on one of `occupied`. Matching
 * origins are what matter: a window opened there hides the other's title bar,
 * whatever the two sizes are.
 */
function coversOccupied(
  bounds: Electron.Rectangle,
  occupied: readonly Electron.Rectangle[]
): boolean {
  const near = MRU_OFFSET_PX / 2;
  return occupied.some(
    (other) => Math.abs(other.x - bounds.x) < near && Math.abs(other.y - bounds.y) < near
  );
}

/**
 * The nearest cascade step from `start` that lands on no open window: down and
 * right first, then up and left. A window clamped into the work area's
 * bottom-right corner can't step further down-right, and stopping there would
 * leave it exactly over a window already in that corner.
 */
function findFreeCascadeSpot(
  start: Electron.Rectangle,
  occupied: readonly Electron.Rectangle[]
): Electron.Rectangle | null {
  for (const direction of [1, -1]) {
    let candidate = start;
    for (let step = 0; step < MAX_CASCADE_STEPS; step++) {
      const next = clampToDisplay({
        x: candidate.x + direction * MRU_OFFSET_PX,
        y: candidate.y + direction * MRU_OFFSET_PX,
        width: candidate.width,
        height: candidate.height,
      });
      // Pinned against the work area's edges: this direction has no room left.
      if (next.x === candidate.x && next.y === candidate.y) break;
      if (!coversOccupied(next, occupied)) return next;
      candidate = next;
    }
  }
  return null;
}

/** Move a window off any open window it would land on, when a cascade step has room. */
function cascadeOffOccupied(win: BrowserWindow, occupied: readonly Electron.Rectangle[]): void {
  const bounds = win.getBounds();
  if (!coversOccupied(bounds, occupied)) return;
  const spot = findFreeCascadeSpot(bounds, occupied);
  if (spot) win.setBounds(spot);
}

// Mirror the store's own entry type (isFullScreen optional) so the map read back
// from windowStatesStore is assignable here; WindowStateBounds (stricter, with a
// required isFullScreen) is still assignable INTO these slots on write.
type WindowStatesMap = Record<string, WindowStateEntry>;

// Single capped writer all mutation paths route through (per lesson #7586), so
// the MRU cap lives in exactly one place rather than being duplicated across the
// save and prune paths. Object key order is insertion order for these string
// keys, so the earliest project keys are the least-recently-touched — evict them
// first when over the cap. `__legacy__` is never counted or evicted.
function commitWindowStates(windowStates: WindowStatesMap): void {
  const projectKeys = Object.keys(windowStates).filter((k) => k !== LEGACY_KEY);
  const overflow = projectKeys.length - WINDOW_STATE_MRU_CAP;
  for (let i = 0; i < overflow; i++) {
    delete windowStates[projectKeys[i]];
  }
  windowStatesStore.set("windowStates", windowStates);
}

function saveWindowStates(projectPath: string | null | undefined, bounds: WindowStateBounds): void {
  const windowStates: WindowStatesMap = windowStatesStore.get("windowStates") ?? {};
  if (projectPath) {
    // Delete then re-add so a touched path moves to the most-recent slot in
    // insertion order and can't be picked as the eviction victim below.
    delete windowStates[projectPath];
    windowStates[projectPath] = bounds;
  }
  windowStates[LEGACY_KEY] = bounds;
  commitWindowStates(windowStates);
  lastSavedProjectPath = projectPath ?? LEGACY_KEY;
}

/**
 * Drop a project's saved window state — called when the project is removed so
 * `window-states.json` doesn't retain bounds for projects that no longer exist.
 * Routes through the same capped writer as the save path and never writes
 * `undefined` (electron-store v11 rejects it). No-op if the path isn't present.
 */
export function pruneWindowStateForPath(projectPath: string): void {
  if (!projectPath) return;
  const windowStates: WindowStatesMap | undefined = windowStatesStore.get("windowStates");
  if (!windowStates || !(projectPath in windowStates)) return;
  delete windowStates[projectPath];
  commitWindowStates(windowStates);
  if (lastSavedProjectPath === projectPath) {
    lastSavedProjectPath = null;
  }
}

/**
 * Move a project's saved window bounds from `oldPath` to `newPath` after a
 * folder move/rename (#11282, phase 2). Unlike {@link pruneWindowStateForPath}
 * this preserves the bounds rather than dropping them, so a relocated project's
 * window reopens where the user left it instead of reverting to defaults. The
 * moved project's bounds win over any stale entry already sitting at `newPath`.
 * No-op when the old path has no saved state. Routes through the same capped
 * writer and never persists `undefined` (electron-store v11 rejects it).
 */
export function rekeyWindowStateForPath(oldPath: string, newPath: string): void {
  if (!oldPath || !newPath || oldPath === newPath) return;
  const windowStates: WindowStatesMap | undefined = windowStatesStore.get("windowStates");
  if (!windowStates || !(oldPath in windowStates)) return;
  const bounds = windowStates[oldPath];
  delete windowStates[oldPath];
  // Delete any stale entry already at the destination before reassigning, so the
  // moved bounds take a FRESH (most-recent) insertion slot. Insertion order is
  // the MRU-cap policy (see commitWindowStates); overwriting in place would leave
  // the relocated project in the stale entry's old, possibly-evicted position.
  delete windowStates[newPath];
  windowStates[newPath] = bounds;
  commitWindowStates(windowStates);
  if (lastSavedProjectPath === oldPath) {
    lastSavedProjectPath = newPath;
  }
}

const RESTORE_ROUNDING_PX = 16;

function keepRestoredBounds(
  actual: Electron.Rectangle,
  restored: Electron.Rectangle | null
): Electron.Rectangle {
  if (!restored) return actual;
  const close = (a: number, b: number) => Math.abs(a - b) <= RESTORE_ROUNDING_PX;
  return close(actual.x, restored.x) &&
    close(actual.y, restored.y) &&
    close(actual.width, restored.width) &&
    close(actual.height, restored.height)
    ? restored
    : actual;
}

/**
 * What a window needs from its owner to keep its bounds under the right project
 * across project switches, and to stay clear of the other windows.
 */
export interface WindowStateTracking {
  /**
   * The folder of the project the window is showing now, or null when it shows
   * none (the picker, a scratch, a host's project). Bounds are saved under it
   * because it is the project the open-window manifest reopens the window on.
   * The process-global current project is no stand-in: it names whichever
   * window switched last (#11101), so with two windows open every move of one
   * was saved over the other's bounds.
   */
  getShownProjectPath: (win: BrowserWindow) => string | null;
  /** Subscribe to windows changing what they show. Returns the unsubscribe. */
  onShownProjectChange?: (listener: () => void) => () => void;
  /**
   * The bounds of the app's other open windows. A window that cannot go back to
   * its own saved spot cascades off any of them it would land on.
   */
  getOccupiedBounds?: () => Electron.Rectangle[];
}

const stopTrackingOnClose = new WeakMap<BrowserWindow, () => void>();

/**
 * Stop following the window's project switches. Called from the window's own
 * "closed" handler: a listener of its own was the eleventh on every app window,
 * and an unpackaged build exits on Node's MaxListenersExceededWarning.
 */
export function disposeWindowStateTracking(win: BrowserWindow): void {
  stopTrackingOnClose.get(win)?.();
  stopTrackingOnClose.delete(win);
}

/**
 * Create a window at the bounds saved for `projectPath` — or, without them, at
 * the most recent window's bounds — and keep its bounds saved as it moves.
 */
export function createWindowWithState(
  options: Electron.BrowserWindowConstructorOptions,
  projectPath?: string | null,
  tracking?: WindowStateTracking
): BrowserWindow {
  const windowState = resolveWindowBounds(projectPath);

  const win = new BrowserWindow({
    ...options,
    ...(windowState.x !== undefined && { x: windowState.x }),
    ...(windowState.y !== undefined && { y: windowState.y }),
    width: windowState.width,
    height: windowState.height,
  });

  let bounds = win.getBounds();
  const hasSavedPosition = windowState.x !== undefined && windowState.y !== undefined;
  // Back exactly where this project's window was. Every other placement —
  // borrowed bounds, saved bounds the displays no longer fit, a centred
  // fallback — can land squarely on another open window.
  let atOwnSavedSpot = false;
  // When the saved state has no x/y (cold-start / first-run / defaults), getBounds() on a
  // show:false window returns placeholder coordinates, so getDisplayMatching would route to
  // the primary display anyway — call it directly to make the intent explicit (#10076).
  const display = hasSavedPosition ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay();

  if (
    !display ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    win.center();
  } else {
    const workArea = display.workArea;
    // Some Wayland/GNOME compositors report a zero-dimension workArea; fall back to the
    // display's full bounds so the clamp math below never produces a 0x0 window.
    const safeWorkArea = workArea.width > 0 && workArea.height > 0 ? workArea : display.bounds;

    const clampedWidth = Math.round(Math.min(bounds.width, safeWorkArea.width));
    const clampedHeight = Math.round(Math.min(bounds.height, safeWorkArea.height));

    // Always run the size clamp — the bug (#10076) was that the coordinate-less path
    // short-circuited to win.center() and skipped this entirely, leaving an oversized
    // default window off-screen on small displays (1366x768 taskbar, 1280x720, RDP, VMs).
    const sizeClamped = clampedWidth !== bounds.width || clampedHeight !== bounds.height;
    if (sizeClamped) {
      win.setSize(clampedWidth, clampedHeight);
      bounds = win.getBounds();
    }

    if (hasSavedPosition) {
      // Route through clampToDisplay so windows that are partially off-screen (e.g.
      // x=-300 on a 1920px display) get pulled back to keep the title bar reachable,
      // not just the >50% off-screen case the old inline math caught.
      const clamped = clampToDisplay({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      });
      win.setBounds(clamped);
      atOwnSavedSpot =
        windowState.ownSaved && !sizeClamped && clamped.x === bounds.x && clamped.y === bounds.y;
    } else {
      win.center();
    }
  }

  if (!atOwnSavedSpot && tracking?.getOccupiedBounds) {
    cascadeOffOccupied(win, tracking.getOccupiedBounds());
  }

  // Electron's maximize() on a hidden window shows it, maximized, and on Linux
  // that show activates it: the window maps before its reveal gate, and a
  // restored background window takes focus and the top of the stack from the
  // window the user is in. On Linux the maximize waits for the reveal instead.
  let maximizeOnShow = false;
  if (windowState.isFullScreen) {
    win.once("show", () => {
      if (!win.isDestroyed()) {
        win.setFullScreen(true);
      }
    });
  } else if (windowState.isMaximized) {
    if (process.platform === "linux" && options.show === false) {
      maximizeOnShow = true;
      win.once("show", () => {
        maximizeOnShow = false;
        if (!win.isDestroyed()) {
          win.maximize();
        }
      });
    } else {
      win.maximize();
    }
  }

  // The project this window's bounds belong to: the one it opened on until it
  // shows one, then the one it shows. A switch saves them again under the
  // project switched to, so the window the manifest reopens on it comes back here.
  let boundsKey: string | null = projectPath ?? null;
  let hasShownProject = false;
  const readShownProjectPath = (): string | null => {
    const shown = tracking?.getShownProjectPath(win) ?? null;
    if (shown) hasShownProject = true;
    return shown;
  };
  const resolveSaveKey = (): string | null => {
    if (!tracking) return projectPath ?? getCurrentProjectPath();
    // Before the window shows any project, it is still the window for the one
    // it opened on. Once it has shown one, showing none saves nothing per project.
    return readShownProjectPath() ?? (hasShownProject ? null : (projectPath ?? null));
  };

  // At fractional display scaling on Windows, a window with a hidden title bar
  // reports bounds a few pixels larger than it was created or set with (1000x700
  // comes back 1006x705 at 125%), so saving what getNormalBounds() reports grew
  // the window on every launch. Until the user moves or resizes it past that
  // rounding, keep saving the bounds it was restored from — only when it opened
  // at its own saved spot, not one clamped or cascaded from it.
  const restoredBounds =
    process.platform === "win32" &&
    atOwnSavedSpot &&
    windowState.x !== undefined &&
    windowState.y !== undefined
      ? { x: windowState.x, y: windowState.y, width: windowState.width, height: windowState.height }
      : null;

  const saveState = (saveKey: string | null = resolveSaveKey()) => {
    if (win.isDestroyed()) return;

    const isMaximized = win.isMaximized() || maximizeOnShow;
    const isFullScreen = win.isFullScreen();

    const normalBounds = keepRestoredBounds(win.getNormalBounds(), restoredBounds);

    const entry: WindowStateBounds = {
      x: normalBounds.x,
      y: normalBounds.y,
      width: normalBounds.width,
      height: normalBounds.height,
      isMaximized,
      isFullScreen,
    };

    saveWindowStates(saveKey, entry);
    boundsKey = saveKey;
  };

  // Wrapped so the event Electron passes a handler never reaches saveState as a key.
  const debouncedSaveState = debounce(() => saveState(), 500);

  win.on("resize", () => debouncedSaveState());
  win.on("move", () => debouncedSaveState());
  win.on("close", () => {
    debouncedSaveState.cancel();
    saveState();
  });

  if (tracking?.onShownProjectChange) {
    const unsubscribe = tracking.onShownProjectChange(() => {
      if (win.isDestroyed()) return;
      const shown = readShownProjectPath();
      // Nothing shown yet is a window still coming up, not one that left its project.
      if (shown === boundsKey || (!shown && !hasShownProject)) return;
      // A move still waiting to save was made under the project shown before
      // the switch, so it saves there first.
      if (debouncedSaveState.pending()) {
        debouncedSaveState.cancel();
        saveState(boundsKey);
      }
      boundsKey = shown;
      if (shown) debouncedSaveState();
    });
    stopTrackingOnClose.set(win, unsubscribe);
  }

  return win;
}
