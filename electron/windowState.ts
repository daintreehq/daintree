import { BrowserWindow, screen } from "electron";
import { windowStatesStore } from "./store.js";

const LEGACY_KEY = "__legacy__";
const MRU_OFFSET_PX = 30;

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
}

function debounce<T extends (...args: unknown[]) => void>(
  func: T,
  wait: number
): DebouncedFunction<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: Parameters<T>) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
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

function resolveWindowBounds(projectPath: string | null | undefined): WindowStateBounds {
  // 1. Try per-project state
  const windowStates = windowStatesStore.get("windowStates") ?? {};
  if (projectPath) {
    if (windowStates[projectPath]) {
      return { isFullScreen: false, ...windowStates[projectPath] };
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
      };
    }
  }

  // 3. Cold-start restore: startup may not know the project path yet, so use
  // the last shell window state exactly (no cascade offset, preserve maximize).
  if (!projectPath) {
    const mru = getMruBounds();
    if (mru) {
      return mru;
    }
  }

  // 4. Defaults
  return { width: 1200, height: 800, isMaximized: false, isFullScreen: false };
}

type WindowStatesMap = Record<string, WindowStateBounds>;

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

export function createWindowWithState(
  options: Electron.BrowserWindowConstructorOptions,
  projectPath?: string | null
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
    if (clampedWidth !== bounds.width || clampedHeight !== bounds.height) {
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
    } else {
      win.center();
    }
  }

  if (windowState.isFullScreen) {
    win.once("show", () => {
      if (!win.isDestroyed()) {
        win.setFullScreen(true);
      }
    });
  } else if (windowState.isMaximized) {
    win.maximize();
  }

  const saveState = () => {
    if (win.isDestroyed()) return;

    const isMaximized = win.isMaximized();
    const isFullScreen = win.isFullScreen();

    const normalBounds = win.getNormalBounds();

    const entry: WindowStateBounds = {
      x: normalBounds.x,
      y: normalBounds.y,
      width: normalBounds.width,
      height: normalBounds.height,
      isMaximized,
      isFullScreen,
    };

    const resolvedPath = projectPath ?? getCurrentProjectPath();
    saveWindowStates(resolvedPath, entry);
  };

  const debouncedSaveState = debounce(saveState, 500);

  win.on("resize", debouncedSaveState);
  win.on("move", debouncedSaveState);
  win.on("close", () => {
    debouncedSaveState.cancel();
    saveState();
  });

  return win;
}
