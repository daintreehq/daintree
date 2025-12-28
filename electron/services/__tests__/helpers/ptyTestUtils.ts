import { vi } from "vitest";
import { randomUUID } from "crypto";
import type { IPty } from "node-pty";
import { PtyManager } from "../../PtyManager.js";
import { events, type CanopyEventMap } from "../../events.js";

export interface MockPtyOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  shell?: string;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function waitForEvent<T>(
  emitter: { once: (event: string, listener: (...args: unknown[]) => void) => void },
  event: string,
  timeout = 5000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for event: ${event}`));
    }, timeout);

    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args as T);
    });
  });
}

export async function waitForData(
  manager: PtyManager,
  terminalId: string,
  matcher: (data: string) => boolean,
  timeout = 5000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for matching data on terminal ${terminalId}`));
    }, timeout);

    let accumulated = "";

    const handler = (id: string, data: string) => {
      if (id === terminalId) {
        accumulated += data;
        if (matcher(data) || matcher(accumulated)) {
          cleanup();
          resolve(accumulated);
        }
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      manager.off("data", handler);
    };

    manager.on("data", handler);
  });
}

export async function waitForExit(
  manager: PtyManager,
  terminalId: string,
  timeout = 5000
): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for exit on terminal ${terminalId}`));
    }, timeout);

    const handler = (id: string, exitCode: number) => {
      if (id === terminalId) {
        cleanup();
        resolve(exitCode);
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      manager.off("exit", handler);
    };

    manager.on("exit", handler);
  });
}

export async function waitForAgentStateChange(
  _manager: PtyManager,
  terminalId: string,
  timeout = 5000,
  targetState?: string
): Promise<{ id: string; state: string; trigger: string; timestamp: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      const stateMsg = targetState ? ` to state '${targetState}'` : "";
      reject(
        new Error(`Timeout waiting for agent state change${stateMsg} on terminal ${terminalId}`)
      );
    }, timeout);

    // Note: agent:state-changed events use terminalId, not id
    const handler = (data: CanopyEventMap["agent:state-changed"]) => {
      if (data.terminalId === terminalId) {
        // If targetState is specified, only resolve when we reach that state
        if (targetState && data.state !== targetState) {
          return;
        }
        cleanup();
        // Return with 'id' for backwards compatibility with existing tests
        resolve({
          id: data.terminalId ?? "",
          state: data.state,
          trigger: data.trigger,
          timestamp: data.timestamp,
        });
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      events.off("agent:state-changed", handler);
    };

    // Use global events bus, not manager instance
    events.on("agent:state-changed", handler);
  });
}

export function collectDataFor(
  manager: PtyManager,
  terminalId: string,
  duration: number
): Promise<string[]> {
  return new Promise((resolve) => {
    const chunks: string[] = [];

    const handler = (id: string, data: string) => {
      if (id === terminalId) {
        chunks.push(data);
      }
    };

    manager.on("data", handler);

    setTimeout(() => {
      manager.off("data", handler);
      resolve(chunks);
    }, duration);
  });
}

export async function cleanupPtyManager(manager: PtyManager): Promise<void> {
  const terminals = manager.getAll();
  const killPromises = terminals.map((term) => manager.kill(term.id));
  await Promise.all(killPromises);
  manager.dispose();
}

export function getShellCommand(command: string): { shell: string; args: string[] } {
  const isWindows = process.platform === "win32";

  if (isWindows) {
    return {
      shell: "cmd.exe",
      args: ["/c", command],
    };
  }

  return {
    shell: "/bin/sh",
    args: ["-c", command],
  };
}

export async function spawnEchoTerminal(
  manager: PtyManager,
  message: string,
  options?: { type?: string; worktreeId?: string }
): Promise<string> {
  const { shell, args } = getShellCommand(`echo "${message}"`);
  const id = randomUUID();

  manager.spawn(id, {
    cwd: process.cwd(),
    shell,
    args,
    cols: 80,
    rows: 24,
    type: options?.type as any,
    worktreeId: options?.worktreeId,
  });

  return id;
}

export async function spawnShellTerminal(
  manager: PtyManager,
  options?: {
    cwd?: string;
    type?: string;
    worktreeId?: string;
    cols?: number;
    rows?: number;
    kind?: "terminal" | "agent" | "browser";
  }
): Promise<string> {
  const isWindows = process.platform === "win32";
  const shell = isWindows ? "cmd.exe" : "/bin/sh";
  const id = randomUUID();

  // If a type is provided (e.g., "claude", "gemini"), treat it as an agent terminal
  // unless it's explicitly "terminal" which is a shell terminal
  const isAgent = (!!options?.type && options.type !== "terminal") || options?.kind === "agent";

  manager.spawn(id, {
    cwd: options?.cwd || process.cwd(),
    shell,
    cols: options?.cols || 80,
    rows: options?.rows || 24,
    type: options?.type as any,
    worktreeId: options?.worktreeId,
    kind: isAgent ? "agent" : (options?.kind ?? "terminal"),
    agentId: isAgent ? id : undefined,
  });

  return id;
}

export function mockPtyProcess(): IPty {
  return {
    pid: 12345,
    cols: 80,
    rows: 24,
    process: "sh",
    handleFlowControl: false,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    clear: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  };
}
