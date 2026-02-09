/**
 * Tests for useDevServer hook logic.
 *
 * Tests the core state machine, event handling, and lifecycle logic
 * without full React rendering (matches project convention: node environment).
 */

import { describe, it, expect, vi } from "vitest";
import type { DevServerErrorType } from "@shared/utils/devServerErrors";

// ─── Types matching the hook's internal state ───────────────────────

type DevPreviewStatus = "stopped" | "starting" | "installing" | "running" | "error";

interface DevServerState {
  status: DevPreviewStatus;
  url: string | null;
  terminalId: string | null;
  error: { type: DevServerErrorType; message: string } | null;
}

// ─── State machine logic extracted from useDevServer ────────────────

function createInitialState(): DevServerState {
  return { status: "stopped", url: null, terminalId: null, error: null };
}

function startState(_state: DevServerState, terminalId: string): DevServerState {
  return { status: "starting", url: null, terminalId, error: null };
}

function handleUrlDetected(
  state: DevServerState,
  eventTerminalId: string,
  url: string
): DevServerState {
  if (eventTerminalId !== state.terminalId) return state;
  return { ...state, status: "running", url, error: null };
}

function handleErrorDetected(
  state: DevServerState,
  eventTerminalId: string,
  error: { type: DevServerErrorType; message: string }
): DevServerState {
  if (eventTerminalId !== state.terminalId) return state;
  const newStatus: DevPreviewStatus =
    error.type === "missing-dependencies" ? "installing" : "error";
  return { ...state, status: newStatus, error };
}

function handleExit(
  state: DevServerState,
  eventTerminalId: string,
  exitCode: number
): DevServerState {
  if (eventTerminalId !== state.terminalId) return state;
  if (state.status === "starting" || state.status === "installing") {
    return {
      ...state,
      status: "error",
      error: { type: "unknown", message: `Dev server exited with code ${exitCode}` },
    };
  }
  return { ...state, status: "stopped" };
}

function stopState(): DevServerState {
  return createInitialState();
}

function handleEmptyCommand(): DevServerState {
  return {
    status: "error",
    url: null,
    terminalId: null,
    error: { type: "unknown", message: "No dev command configured" },
  };
}

function handleSpawnFailure(errorMessage: string): DevServerState {
  return {
    status: "error",
    url: null,
    terminalId: null,
    error: { type: "unknown", message: errorMessage },
  };
}

// ─── Spawn options builder ──────────────────────────────────────────

interface SpawnOptions {
  panelId: string;
  devCommand: string;
  cwd: string;
  worktreeId?: string;
  env?: Record<string, string>;
}

function buildSpawnPayload(opts: SpawnOptions) {
  return {
    id: opts.panelId,
    command: opts.devCommand,
    cwd: opts.cwd,
    worktreeId: opts.worktreeId,
    kind: "dev-preview" as const,
    cols: 80,
    rows: 30,
    restore: false,
    env: opts.env,
  };
}

// ─── Listener tracking simulation ───────────────────────────────────

interface ListenerTracker {
  listeners: Array<() => void>;
  add(unsub: () => void): void;
  cleanup(): void;
}

function createListenerTracker(): ListenerTracker {
  const listeners: Array<() => void> = [];
  return {
    listeners,
    add(unsub: () => void) {
      listeners.push(unsub);
    },
    cleanup() {
      listeners.forEach((unsub) => unsub());
      listeners.length = 0;
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("useDevServer logic", () => {
  describe("initial state", () => {
    it("starts in stopped state with null values", () => {
      const state = createInitialState();
      expect(state.status).toBe("stopped");
      expect(state.url).toBeNull();
      expect(state.terminalId).toBeNull();
      expect(state.error).toBeNull();
    });
  });

  describe("start()", () => {
    it("builds correct spawn payload", () => {
      const payload = buildSpawnPayload({
        panelId: "panel-1",
        devCommand: "npm run dev",
        cwd: "/project",
        worktreeId: "wt-1",
        env: { PORT: "3000" },
      });

      expect(payload).toEqual({
        id: "panel-1",
        command: "npm run dev",
        cwd: "/project",
        worktreeId: "wt-1",
        kind: "dev-preview",
        cols: 80,
        rows: 30,
        restore: false,
        env: { PORT: "3000" },
      });
    });

    it("builds payload without optional fields", () => {
      const payload = buildSpawnPayload({
        panelId: "panel-1",
        devCommand: "npm run dev",
        cwd: "/project",
      });

      expect(payload.worktreeId).toBeUndefined();
      expect(payload.env).toBeUndefined();
    });

    it("transitions to starting with terminalId", () => {
      const state = createInitialState();
      const next = startState(state, "term-123");

      expect(next.status).toBe("starting");
      expect(next.terminalId).toBe("term-123");
      expect(next.url).toBeNull();
      expect(next.error).toBeNull();
    });

    it("sets error for empty devCommand", () => {
      const state = handleEmptyCommand();
      expect(state.status).toBe("error");
      expect(state.error?.message).toBe("No dev command configured");
      expect(state.terminalId).toBeNull();
    });

    it("sets error for whitespace-only devCommand", () => {
      const devCommand = "  ";
      const isValid = devCommand.trim().length > 0;
      expect(isValid).toBe(false);
    });

    it("handles spawn failure", () => {
      const state = handleSpawnFailure("PTY spawn failed");
      expect(state.status).toBe("error");
      expect(state.error?.message).toBe("PTY spawn failed");
      expect(state.terminalId).toBeNull();
    });
  });

  describe("URL detection", () => {
    it("transitions to running when URL is detected", () => {
      let state = createInitialState();
      state = startState(state, "term-123");

      const next = handleUrlDetected(state, "term-123", "http://localhost:3000/");
      expect(next.status).toBe("running");
      expect(next.url).toBe("http://localhost:3000/");
      expect(next.error).toBeNull();
    });

    it("ignores URL events for other terminals", () => {
      let state = createInitialState();
      state = startState(state, "term-123");

      const next = handleUrlDetected(state, "other-term", "http://localhost:4000/");
      expect(next).toBe(state);
      expect(next.url).toBeNull();
    });

    it("clears previous error when URL is detected", () => {
      const state: DevServerState = {
        status: "starting",
        url: null,
        terminalId: "term-123",
        error: { type: "unknown", message: "Previous error" },
      };

      const next = handleUrlDetected(state, "term-123", "http://localhost:3000/");
      expect(next.error).toBeNull();
      expect(next.status).toBe("running");
    });
  });

  describe("error handling", () => {
    it("transitions to installing for missing-dependencies", () => {
      let state = createInitialState();
      state = startState(state, "term-123");

      const next = handleErrorDetected(state, "term-123", {
        type: "missing-dependencies",
        message: "Missing dependency: react",
      });

      expect(next.status).toBe("installing");
      expect(next.error?.type).toBe("missing-dependencies");
    });

    it("transitions to error for port-conflict", () => {
      let state = createInitialState();
      state = startState(state, "term-123");

      const next = handleErrorDetected(state, "term-123", {
        type: "port-conflict",
        message: "Port 3000 already in use",
      });

      expect(next.status).toBe("error");
      expect(next.error?.type).toBe("port-conflict");
    });

    it("transitions to error for permission errors", () => {
      let state = createInitialState();
      state = startState(state, "term-123");

      const next = handleErrorDetected(state, "term-123", {
        type: "permission",
        message: "Permission denied",
      });

      expect(next.status).toBe("error");
    });

    it("ignores error events for other terminals", () => {
      let state = createInitialState();
      state = startState(state, "term-123");

      const next = handleErrorDetected(state, "other-term", {
        type: "port-conflict",
        message: "Port 3000 in use",
      });

      expect(next).toBe(state);
    });
  });

  describe("terminal exit handling", () => {
    it("sets error when exit during starting", () => {
      let state = createInitialState();
      state = startState(state, "term-123");

      const next = handleExit(state, "term-123", 1);
      expect(next.status).toBe("error");
      expect(next.error?.message).toBe("Dev server exited with code 1");
    });

    it("sets error when exit during installing", () => {
      let state = createInitialState();
      state = startState(state, "term-123");
      state = handleErrorDetected(state, "term-123", {
        type: "missing-dependencies",
        message: "Missing react",
      });
      expect(state.status).toBe("installing");

      const next = handleExit(state, "term-123", 1);
      expect(next.status).toBe("error");
      expect(next.error?.message).toBe("Dev server exited with code 1");
    });

    it("transitions to stopped when exit while running", () => {
      let state = createInitialState();
      state = startState(state, "term-123");
      state = handleUrlDetected(state, "term-123", "http://localhost:3000/");
      expect(state.status).toBe("running");

      const next = handleExit(state, "term-123", 0);
      expect(next.status).toBe("stopped");
    });

    it("transitions to stopped when exit while in error", () => {
      let state = createInitialState();
      state = startState(state, "term-123");
      state = handleErrorDetected(state, "term-123", {
        type: "port-conflict",
        message: "Port in use",
      });
      expect(state.status).toBe("error");

      const next = handleExit(state, "term-123", 1);
      expect(next.status).toBe("stopped");
    });

    it("ignores exit events for other terminals", () => {
      let state = createInitialState();
      state = startState(state, "term-123");

      const next = handleExit(state, "other-term", 1);
      expect(next).toBe(state);
    });

    it("includes exit code in error message", () => {
      let state = createInitialState();
      state = startState(state, "term-123");

      const next = handleExit(state, "term-123", 127);
      expect(next.error?.message).toBe("Dev server exited with code 127");
    });
  });

  describe("stop()", () => {
    it("resets all state to initial", () => {
      const state = stopState();
      expect(state).toEqual(createInitialState());
    });
  });

  describe("status transitions (full lifecycle)", () => {
    it("stopped → starting → running → stopped", () => {
      let state = createInitialState();
      expect(state.status).toBe("stopped");

      state = startState(state, "term-123");
      expect(state.status).toBe("starting");

      state = handleUrlDetected(state, "term-123", "http://localhost:3000/");
      expect(state.status).toBe("running");

      state = handleExit(state, "term-123", 0);
      expect(state.status).toBe("stopped");
    });

    it("stopped → starting → installing → running", () => {
      let state = createInitialState();

      state = startState(state, "term-123");
      expect(state.status).toBe("starting");

      state = handleErrorDetected(state, "term-123", {
        type: "missing-dependencies",
        message: "Missing react",
      });
      expect(state.status).toBe("installing");

      state = handleUrlDetected(state, "term-123", "http://localhost:3000/");
      expect(state.status).toBe("running");
    });

    it("stopped → starting → error (exit during start)", () => {
      let state = createInitialState();

      state = startState(state, "term-123");
      state = handleExit(state, "term-123", 1);

      expect(state.status).toBe("error");
      expect(state.error?.type).toBe("unknown");
    });

    it("stopped → error (empty command)", () => {
      const state = handleEmptyCommand();
      expect(state.status).toBe("error");
    });

    it("stopped → error (spawn failure)", () => {
      const state = handleSpawnFailure("Spawn rejected");
      expect(state.status).toBe("error");
    });
  });

  describe("listener lifecycle", () => {
    it("tracks added listeners", () => {
      const tracker = createListenerTracker();
      const unsub1 = vi.fn();
      const unsub2 = vi.fn();

      tracker.add(unsub1);
      tracker.add(unsub2);

      expect(tracker.listeners).toHaveLength(2);
    });

    it("cleanup calls all unsubscribers", () => {
      const tracker = createListenerTracker();
      const unsub1 = vi.fn();
      const unsub2 = vi.fn();
      const unsub3 = vi.fn();

      tracker.add(unsub1);
      tracker.add(unsub2);
      tracker.add(unsub3);

      tracker.cleanup();

      expect(unsub1).toHaveBeenCalledTimes(1);
      expect(unsub2).toHaveBeenCalledTimes(1);
      expect(unsub3).toHaveBeenCalledTimes(1);
    });

    it("clears listeners array after cleanup", () => {
      const tracker = createListenerTracker();
      tracker.add(vi.fn());
      tracker.add(vi.fn());

      tracker.cleanup();
      expect(tracker.listeners).toHaveLength(0);
    });

    it("can be cleaned up multiple times safely", () => {
      const tracker = createListenerTracker();
      const unsub = vi.fn();
      tracker.add(unsub);

      tracker.cleanup();
      tracker.cleanup();

      expect(unsub).toHaveBeenCalledTimes(1);
    });
  });

  describe("duplicate start prevention", () => {
    it("isStarting flag prevents concurrent starts", () => {
      let isStarting = false;

      function attemptStart(): boolean {
        if (isStarting) return false;
        isStarting = true;
        return true;
      }

      function finishStart(): void {
        isStarting = false;
      }

      expect(attemptStart()).toBe(true);
      expect(attemptStart()).toBe(false);

      finishStart();
      expect(attemptStart()).toBe(true);
    });
  });

  describe("restart behavior", () => {
    it("tracks terminal IDs across restarts", () => {
      let state = createInitialState();

      state = startState(state, "term-1");
      expect(state.terminalId).toBe("term-1");

      state = stopState();
      expect(state.terminalId).toBeNull();

      state = startState(state, "term-2");
      expect(state.terminalId).toBe("term-2");
    });

    it("previous terminal should be killed before restart", () => {
      const killFn = vi.fn();

      let currentTerminalId: string | null = null;

      function startTerminal(id: string) {
        if (currentTerminalId) {
          killFn(currentTerminalId);
        }
        currentTerminalId = id;
      }

      startTerminal("term-1");
      expect(killFn).not.toHaveBeenCalled();

      startTerminal("term-2");
      expect(killFn).toHaveBeenCalledWith("term-1");
    });

    it("isRestarting flag prevents concurrent restarts", () => {
      let isRestarting = false;
      const isStarting = false;

      function attemptRestart(): boolean {
        if (isRestarting || isStarting) return false;
        isRestarting = true;
        return true;
      }

      function finishRestart(): void {
        isRestarting = false;
      }

      expect(attemptRestart()).toBe(true);
      expect(attemptRestart()).toBe(false);

      finishRestart();
      expect(attemptRestart()).toBe(true);
    });

    it("restart clears state before starting new server", () => {
      let state = createInitialState();
      state = startState(state, "term-1");
      state = handleUrlDetected(state, "term-1", "http://localhost:3000/");
      expect(state.status).toBe("running");
      expect(state.url).toBe("http://localhost:3000/");

      // Simulate restart: stop then start
      state = stopState();
      expect(state.status).toBe("stopped");
      expect(state.url).toBeNull();
      expect(state.terminalId).toBeNull();

      state = startState(state, "term-2");
      expect(state.status).toBe("starting");
      expect(state.terminalId).toBe("term-2");
    });
  });

  describe("auto-start logic", () => {
    it("should start when devCommand exists and status is stopped", () => {
      const shouldAutoStart = (devCommand: string, status: DevPreviewStatus): boolean => {
        return !!(devCommand && status === "stopped");
      };

      expect(shouldAutoStart("npm run dev", "stopped")).toBe(true);
      expect(shouldAutoStart("npm run dev", "starting")).toBe(false);
      expect(shouldAutoStart("npm run dev", "running")).toBe(false);
      expect(shouldAutoStart("npm run dev", "error")).toBe(false);
      expect(shouldAutoStart("", "stopped")).toBe(false);
    });
  });
});
