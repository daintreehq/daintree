import { BrowserWindow, screen } from "electron";
import { windowStatesStore, type WindowStateEntry } from "./store.js";
import { hostBoundsKeyPrefix, scratchBoundsKey } from "./window/windowBoundsKeys.js";

const LEGACY_KEY = "__legacy__";
const MRU_OFFSET_PX = 30;
// How many cascade steps a new window takes off windows it would land on.
const MAX_CASCADE_STEPS = 10;

// Cap on how many per-workspace window-state entries `window-states.json` retains.
// Without it the map grows one entry per workspace ever opened, is never pruned,
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

let lastSavedKey: string | null = null;

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

  if (lastSavedKey && windowStates[lastSavedKey]) {
    return { isFullScreen: false, ...windowStates[lastSavedKey] };
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
  /** The workspace's own saved bounds, as opposed to ones borrowed from another window. */
  ownSaved: boolean;
}

function resolveWindowBounds(key: string | null | undefined): ResolvedWindowBounds {
  // 1. Try per-workspace state
  const windowStates = windowStatesStore.get("windowStates") ?? {};
  if (key) {
    if (windowStates[key]) {
      return { isFullScreen: false, ...windowStates[key], ownSaved: true };
    }

    // 2. MRU cascade for new workspace windows
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

  // 3. Cold-start restore: startup may not know the workspace yet, so use
  // the last shell window state exactly (no cascade offset, preserve maximize).
  if (!key) {
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

/**
 * Move a window off any open window it would land on, when a cascade step has
 * room. Returns the spot it moved to, or null when it stayed put.
 */
function cascadeOffOccupied(
  win: BrowserWindow,
  occupied: readonly Electron.Rectangle[]
): Electron.Rectangle | null {
  const bounds = win.getBounds();
  if (!coversOccupied(bounds, occupied)) return null;
  const spot = findFreeCascadeSpot(bounds, occupied);
  if (spot) win.setBounds(spot);
  return spot;
}

// Mirror the store's own entry type (isFullScreen optional) so the map read back
// from windowStatesStore is assignable here; WindowStateBounds (stricter, with a
// required isFullScreen) is still assignable INTO these slots on write.
type WindowStatesMap = Record<string, WindowStateEntry>;

// Single capped writer all mutation paths route through (per lesson #7586), so
// the MRU cap lives in exactly one place rather than being duplicated across the
// save and prune paths. Object key order is insertion order for these string
// keys, so the earliest workspace keys are the least-recently-touched — evict
// them first when over the cap. `__legacy__` is never counted or evicted.
function commitWindowStates(windowStates: WindowStatesMap): void {
  const workspaceKeys = Object.keys(windowStates).filter((k) => k !== LEGACY_KEY);
  const overflow = workspaceKeys.length - WINDOW_STATE_MRU_CAP;
  for (let i = 0; i < overflow; i++) {
    delete windowStates[workspaceKeys[i]];
  }
  windowStatesStore.set("windowStates", windowStates);
}

function saveWindowStates(key: string | null | undefined, bounds: WindowStateBounds): void {
  const windowStates: WindowStatesMap = windowStatesStore.get("windowStates") ?? {};
  if (key) {
    // Delete then re-add so a touched key moves to the most-recent slot in
    // insertion order and can't be picked as the eviction victim below.
    delete windowStates[key];
    windowStates[key] = bounds;
  }
  windowStates[LEGACY_KEY] = bounds;
  commitWindowStates(windowStates);
  lastSavedKey = key ?? LEGACY_KEY;
}

/**
 * Each tracked window's way of letting go of keys a prune dropped. A window
 * still holding one (a deleted scratch on screen, a picker waiting for a
 * removed host) would otherwise write it straight back with its next save.
 */
const keyRetirers = new Set<(retired: (key: string) => boolean) => void>();

/**
 * Drop the saved window states whose keys match, through the same capped
 * writer as the save path, never writing `undefined` (electron-store v11
 * rejects it). `__legacy__` is never dropped. Open windows let go of matching
 * keys whether or not any were saved yet.
 */
function pruneWindowStates(matches: (key: string) => boolean): void {
  for (const retire of keyRetirers) retire(matches);
  const windowStates: WindowStatesMap | undefined = windowStatesStore.get("windowStates");
  if (!windowStates) return;
  const pruned = Object.keys(windowStates).filter((key) => key !== LEGACY_KEY && matches(key));
  if (pruned.length === 0) return;
  for (const key of pruned) delete windowStates[key];
  commitWindowStates(windowStates);
  if (lastSavedKey !== null && pruned.includes(lastSavedKey)) {
    lastSavedKey = null;
  }
}

/**
 * Drop a project's saved window state — called when the project is removed so
 * `window-states.json` doesn't retain bounds for projects that no longer exist.
 */
export function pruneWindowStateForPath(projectPath: string): void {
  if (!projectPath) return;
  pruneWindowStates((key) => key === projectPath);
}

/** Drop a deleted scratch's saved window state. */
export function pruneWindowStateForScratch(scratchId: string): void {
  if (!scratchId) return;
  const scratchKey = scratchBoundsKey(scratchId);
  pruneWindowStates((key) => key === scratchKey);
}

/** Drop the saved window states of every project on a host removed from this device. */
export function pruneWindowStatesForHost(hostId: string): void {
  const prefix = hostBoundsKeyPrefix(hostId);
  if (!prefix) return;
  pruneWindowStates((key) => key.startsWith(prefix));
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
  if (lastSavedKey === oldPath) {
    lastSavedKey = newPath;
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
 * What a window needs from its owner to keep its bounds under the right
 * workspace across switches, and to stay clear of the other windows.
 */
export interface WindowStateTracking {
  /**
   * The key of the workspace the window is showing now (a local project's
   * folder, or a scratch's or a host's project's id), or of the host's project
   * a restored picker is waiting for, or null when it shows none (the picker).
   * Bounds are saved under it because it is the workspace the open-window
   * manifest reopens the window on. The process-global current
   * project is no stand-in: it names whichever window switched last (#11101),
   * so with two windows open every move of one was saved over the other's
   * bounds.
   */
  getShownBoundsKey: (win: BrowserWindow) => string | null;
  /** Subscribe to windows changing what they show or wait for. Returns the unsubscribe. */
  onShownProjectChange?: (listener: () => void) => () => void;
  /**
   * The bounds of the app's other open windows. A window that cannot go back to
   * its own saved spot cascades off any of them it would land on.
   */
  getOccupiedBounds?: () => Electron.Rectangle[];
}

const stopTrackingOnClose = new WeakMap<BrowserWindow, () => void>();

/**
 * Stop following the window's project switches and the prunes of its keys.
 * Called from the window's own
 * "closed" handler: a listener of its own was the eleventh on every app window,
 * and an unpackaged build exits on Node's MaxListenersExceededWarning.
 */
export function disposeWindowStateTracking(win: BrowserWindow): void {
  stopTrackingOnClose.get(win)?.();
  stopTrackingOnClose.delete(win);
}

/**
 * Create a window at the bounds saved under `initialKey` (the workspace it
 * opens on) — or, without them, at the most recent window's bounds — and keep
 * its bounds saved as it moves.
 */
export function createWindowWithState(
  options: Electron.BrowserWindowConstructorOptions,
  initialKey?: string | null,
  tracking?: WindowStateTracking
): BrowserWindow {
  const windowState = resolveWindowBounds(initialKey);

  const win = new BrowserWindow({
    ...options,
    ...(windowState.x !== undefined && { x: windowState.x }),
    ...(windowState.y !== undefined && { y: windowState.y }),
    width: windowState.width,
    height: windowState.height,
  });

  let bounds = win.getBounds();
  const hasSavedPosition = windowState.x !== undefined && windowState.y !== undefined;
  // Back exactly where this workspace's window was. Every other placement —
  // borrowed bounds, saved bounds the displays no longer fit, a centred
  // fallback — can land squarely on another open window.
  let atOwnSavedSpot = false;
  // Where this code put the window, in its own numbers rather than the ones the
  // window reports back (see the Windows rounding note at saveState).
  let placedBounds: Electron.Rectangle | null = null;
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
    const placedWidth = Math.min(windowState.width, clampedWidth);
    const placedHeight = Math.min(windowState.height, clampedHeight);
    const placedSize =
      Number.isFinite(placedWidth) && Number.isFinite(placedHeight)
        ? { width: placedWidth, height: placedHeight }
        : null;

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
      const unmoved = clamped.x === bounds.x && clamped.y === bounds.y;
      // Unmoved, it sits at the position it was created with, not the one read back.
      if (placedSize) {
        placedBounds = unmoved
          ? { x: windowState.x ?? clamped.x, y: windowState.y ?? clamped.y, ...placedSize }
          : { x: clamped.x, y: clamped.y, ...placedSize };
      }
      atOwnSavedSpot = windowState.ownSaved && !sizeClamped && unmoved;
    } else {
      win.center();
      const centred = win.getBounds();
      if (placedSize) placedBounds = { x: centred.x, y: centred.y, ...placedSize };
    }
  }

  if (!atOwnSavedSpot && tracking?.getOccupiedBounds) {
    const spot = cascadeOffOccupied(win, tracking.getOccupiedBounds());
    if (spot && placedBounds) placedBounds = { ...placedBounds, x: spot.x, y: spot.y };
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

  // The workspace this window's bounds belong to: the one it opened on until it
  // shows one, then the one it shows. A switch saves them again under the
  // workspace switched to, so the window the manifest reopens on it comes back here.
  let boundsKey: string | null = initialKey ?? null;
  // The key saves fall back to before the window shows anything.
  let openedOnKey: string | null = initialKey ?? null;
  let hasShownProject = false;
  const readShownKey = (): string | null => {
    const shown = tracking?.getShownBoundsKey(win) ?? null;
    if (shown) hasShownProject = true;
    return shown;
  };
  const resolveSaveKey = (): string | null => {
    if (!tracking) return initialKey ?? getCurrentProjectPath();
    // Before the window shows any workspace, it is still the window for the one
    // it opened on. Once it has shown one, showing none saves nothing per workspace.
    return readShownKey() ?? (hasShownProject ? null : openedOnKey);
  };
  const retireKeys = (retired: (key: string) => boolean) => {
    if (boundsKey !== null && retired(boundsKey)) boundsKey = null;
    if (openedOnKey !== null && retired(openedOnKey)) openedOnKey = null;
  };
  keyRetirers.add(retireKeys);

  // At fractional display scaling on Windows, a window with a hidden title bar
  // reports bounds a few pixels larger than it was created or set with (1000x700
  // comes back 1006x705 at 125%), so saving what getNormalBounds() reports grew
  // the window on every launch. Until the user moves or resizes it past that
  // rounding, keep saving the bounds it was placed at. That holds for every
  // placement — a no-project cold start, the centred default, one the work area
  // clamped or a cascade moved — or the growth comes back through it: a window
  // grown past the taskbar is clamped up, and from then on saved what it reported.
  const restoredBounds = process.platform === "win32" ? placedBounds : null;

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

  let unsubscribe: (() => void) | undefined;
  if (tracking?.onShownProjectChange) {
    unsubscribe = tracking.onShownProjectChange(() => {
      if (win.isDestroyed()) return;
      const shown = readShownKey();
      // Nothing shown yet is a window still coming up, not one that left its project.
      if (shown === boundsKey || (!shown && !hasShownProject)) return;
      // A move still waiting to save was made under the workspace shown before
      // the switch, so it saves there first.
      if (debouncedSaveState.pending()) {
        debouncedSaveState.cancel();
        saveState(boundsKey);
      }
      boundsKey = shown;
      if (shown) debouncedSaveState();
    });
  }
  stopTrackingOnClose.set(win, () => {
    unsubscribe?.();
    keyRetirers.delete(retireKeys);
  });

  return win;
}
