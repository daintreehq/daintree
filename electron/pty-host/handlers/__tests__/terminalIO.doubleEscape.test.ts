import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalIOHandlers } from "../terminalIO.js";
import type { HostContext } from "../types.js";

describe("batch-double-escape", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    let spawnedAt = 100;
    const ptyManager = {
      // A fresh object per read, as the real manager returns.
      getTerminal: vi.fn(() => ({ spawnedAt, wasKilled: false, isExited: false })),
      write: vi.fn(),
    };
    const handler = createTerminalIOHandlers({
      ptyManager,
      sendEvent: vi.fn(),
    } as unknown as HostContext)["batch-double-escape"]!;
    return {
      ptyManager,
      escape: () => handler({ type: "batch-double-escape", ids: ["t1"] }),
      restart: () => {
        spawnedAt = 200;
      },
    };
  }

  it("writes the second Escape to the spawn the first went to, after the gap", () => {
    const { ptyManager, escape } = setup();
    escape();
    expect(ptyManager.write.mock.calls).toEqual([["t1", "\x1b"]]);
    vi.advanceTimersByTime(49);
    expect(ptyManager.write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(ptyManager.write.mock.calls).toEqual([
      ["t1", "\x1b"],
      ["t1", "\x1b"],
    ]);
  });

  // #14551: a restart under the same id in the gap is a new run that asked for no Escape.
  it("drops the second Escape when the terminal was restarted in the gap", () => {
    const { ptyManager, escape, restart } = setup();
    escape();
    restart();
    vi.advanceTimersByTime(50);
    expect(ptyManager.write).toHaveBeenCalledTimes(1);
  });
});
