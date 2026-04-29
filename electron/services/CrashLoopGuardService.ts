import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

const STATE_FILENAME = "crash-loop-state.json";
const CRASH_THRESHOLD = 3;
const HARD_STOP_THRESHOLD = 5;
const STABILITY_TIMEOUT_MS = 5 * 60 * 1000;
const RAPID_CRASH_WINDOW_MS = 300_000;

interface CrashLoopState {
  version: 1;
  crashes: number;
  launches: number[];
  cleanExit: boolean;
  lastReset: number;
}

function freshState(): CrashLoopState {
  return {
    version: 1,
    crashes: 0,
    launches: [],
    cleanExit: true,
    lastReset: Date.now(),
  };
}

export class CrashLoopGuardService {
  private userData: string;
  private statePath: string;
  private safeMode = false;
  private relaunchAllowed = true;
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;

  constructor() {
    this.userData = app.getPath("userData");
    this.statePath = path.join(this.userData, STATE_FILENAME);
  }

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;

    const state = this.readState();
    const now = Date.now();

    if (!state.cleanExit) {
      const recentLaunches = state.launches.filter((ts) => now - ts < RAPID_CRASH_WINDOW_MS);
      state.crashes = recentLaunches.length;
    } else {
      state.crashes = 0;
      state.launches = [];
    }

    state.launches.push(now);
    if (state.launches.length > HARD_STOP_THRESHOLD) {
      state.launches = state.launches.slice(-HARD_STOP_THRESHOLD);
    }

    state.cleanExit = false;

    this.safeMode = state.crashes >= CRASH_THRESHOLD;
    this.relaunchAllowed = state.crashes < HARD_STOP_THRESHOLD;

    try {
      this.writeState(state);
    } catch (err) {
      console.error("[CrashLoopGuard] Failed to persist state during initialize:", err);
    }

    if (this.safeMode) {
      console.warn(`[CrashLoopGuard] Safe mode activated (${state.crashes} consecutive crashes)`);
    }
    if (!this.relaunchAllowed) {
      console.error(
        `[CrashLoopGuard] Relaunch disabled (${state.crashes} crashes reached hard stop)`
      );
    }

    console.log(
      `[CrashLoopGuard] Initialized — crashes: ${state.crashes}, safeMode: ${this.safeMode}, relaunchAllowed: ${this.relaunchAllowed}`
    );
  }

  isSafeMode(): boolean {
    return this.safeMode;
  }

  shouldRelaunch(): boolean {
    return this.relaunchAllowed;
  }

  markCleanExit(): void {
    try {
      const state = this.readState();
      state.cleanExit = true;
      this.writeState(state);
    } catch (err) {
      console.error("[CrashLoopGuard] Failed to mark clean exit:", err);
    }
  }

  startStabilityTimer(): void {
    if (this.stabilityTimer) return;
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null;
      try {
        const state = freshState();
        this.writeState(state);
        this.safeMode = false;
        this.relaunchAllowed = true;
        console.log("[CrashLoopGuard] Stability timer fired — crash counter reset");
      } catch (err) {
        console.error("[CrashLoopGuard] Failed to reset crash counter:", err);
      }
    }, STABILITY_TIMEOUT_MS);
  }

  dispose(): void {
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
  }

  private readState(): CrashLoopState {
    try {
      if (!fs.existsSync(this.statePath)) {
        return freshState();
      }
      const raw = fs.readFileSync(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<CrashLoopState>;
      if (
        parsed.version === 1 &&
        typeof parsed.crashes === "number" &&
        Array.isArray(parsed.launches) &&
        typeof parsed.cleanExit === "boolean" &&
        typeof parsed.lastReset === "number"
      ) {
        return parsed as CrashLoopState;
      }
      console.warn("[CrashLoopGuard] Invalid state file, using fresh state");
      return freshState();
    } catch {
      console.warn("[CrashLoopGuard] Failed to read state file, using fresh state");
      return freshState();
    }
  }

  private writeState(state: CrashLoopState): void {
    const data = JSON.stringify(state);

    // Ensure the parent directory exists (e.g. first launch of dev userData)
    const dir = path.dirname(this.statePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Try atomic write (tmp + rename), fall back to direct write
    const tmpPath = `${this.statePath}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, data, "utf8");
      fs.renameSync(tmpPath, this.statePath);
    } catch {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      // Fallback: direct write (non-atomic but functional)
      fs.writeFileSync(this.statePath, data, "utf8");
    }
  }
}

export function isSafeModeActive(userDataPath?: string): boolean {
  const dir = userDataPath ?? app.getPath("userData");
  const statePath = path.join(dir, STATE_FILENAME);

  try {
    if (!fs.existsSync(statePath)) return false;
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<CrashLoopState>;
    if (
      parsed.version === 1 &&
      typeof parsed.crashes === "number" &&
      Array.isArray(parsed.launches) &&
      typeof parsed.cleanExit === "boolean" &&
      typeof parsed.lastReset === "number"
    ) {
      if (parsed.cleanExit) return false;
      const now = Date.now();
      const recentLaunches = parsed.launches.filter((ts) => now - ts < RAPID_CRASH_WINDOW_MS);
      return recentLaunches.length >= CRASH_THRESHOLD;
    }
    return false;
  } catch {
    return false;
  }
}

let instance: CrashLoopGuardService | null = null;

export function getCrashLoopGuard(): CrashLoopGuardService {
  if (!instance) {
    instance = new CrashLoopGuardService();
  }
  return instance;
}

export function initializeCrashLoopGuard(): CrashLoopGuardService {
  const service = getCrashLoopGuard();
  service.initialize();
  return service;
}
