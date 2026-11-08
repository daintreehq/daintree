import { describe, expect, it, vi } from "vitest";
import { readInputLines, type InputLinePtyClient } from "../canopyInputLines.js";

const EDGE = "────────";

/** A Claude Code screen in the serializer's shape: a reply, then the framed input box. */
function screen(box: string): string {
  return `⏺ Done.\r\n${EDGE}\r\n${box}\r\n${EDGE}\r\n  ? for shortcuts`;
}

interface Terminal {
  spawnedAt: number;
  screen: string;
  agent?: string;
  isExited?: boolean;
}

function client(terminals: Record<string, Terminal>) {
  const getSerializedStateAsync = vi.fn(async (id: string, _options?: { tailRows?: number }) => {
    const terminal = terminals[id];
    return terminal ? { data: terminal.screen, cols: 80, rows: 24 } : null;
  });
  const getTerminalAsync = vi.fn(async (id: string) => {
    const terminal = terminals[id];
    return terminal
      ? {
          spawnedAt: terminal.spawnedAt,
          isExited: terminal.isExited,
          detectedAgentId: terminal.agent,
        }
      : null;
  });
  return {
    ptyClient: { getTerminalAsync, getSerializedStateAsync } as unknown as InputLinePtyClient,
    getSerializedStateAsync,
  };
}

function states(readings: Array<{ runId: string; state: string }>): Record<string, string> {
  return Object.fromEntries(readings.map((reading) => [reading.runId, reading.state]));
}

describe("readInputLines", () => {
  it("tells typed text from the agent's own suggestion and an empty box, by the agent's rule", async () => {
    const { ptyClient, getSerializedStateAsync } = client({
      typed: { spawnedAt: 1, agent: "claude", screen: screen("❯ fix the login bug") },
      ghost: { spawnedAt: 1, agent: "claude", screen: screen("❯ \x1b[2mopen the PR\x1b[22m") },
      empty: { spawnedAt: 1, agent: "claude", screen: screen("❯ ") },
    });
    const readings = await readInputLines(ptyClient, [
      { runId: "typed", spawnedAt: 1 },
      { runId: "ghost", spawnedAt: 1 },
      { runId: "empty", spawnedAt: 1 },
    ]);
    expect(states(readings)).toEqual({ typed: "typed", ghost: "suggestion", empty: "empty" });
    // The screen alone: the box is never in the scrollback.
    expect(getSerializedStateAsync.mock.calls.every(([, options]) => options?.tailRows === 0)).toBe(
      true
    );
  });

  it("reads nothing as typed where nothing could be seen", async () => {
    const { ptyClient } = client({
      respawned: { spawnedAt: 2, agent: "claude", screen: screen("❯ half a prompt") },
      exited: { spawnedAt: 1, agent: "claude", isExited: true, screen: screen("❯ text") },
      shell: { spawnedAt: 1, screen: screen("❯ ls -la") },
    });
    const readings = await readInputLines(ptyClient, [
      { runId: "respawned", spawnedAt: 1 },
      { runId: "exited", spawnedAt: 1 },
      { runId: "shell", spawnedAt: 1 },
      { runId: "gone", spawnedAt: 1 },
    ]);
    expect(states(readings)).toEqual({
      respawned: "unknown",
      exited: "unknown",
      shell: "unknown",
      gone: "unknown",
    });
  });

  it("reads a run named twice once", async () => {
    const { ptyClient, getSerializedStateAsync } = client({
      a: { spawnedAt: 1, agent: "claude", screen: screen("❯ ") },
    });
    const readings = await readInputLines(ptyClient, [
      { runId: "a", spawnedAt: 1 },
      { runId: "a", spawnedAt: 1 },
    ]);
    expect(readings).toHaveLength(1);
    expect(getSerializedStateAsync).toHaveBeenCalledTimes(1);
  });
});
