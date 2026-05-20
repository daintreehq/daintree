import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TerminalInstance } from "@shared/types";

const fullWakeMock = vi.fn();
const isFocusedMock = vi.fn();
const logWarnMock = vi.fn();

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    fullWakeForVisibilityRestore: fullWakeMock,
    isFocused: isFocusedMock,
  },
}));

vi.mock("@/utils/logger", () => ({
  logWarn: logWarnMock,
}));

let mockActiveWorktreeId: string | null = null;
let mockPanelIds: string[] = [];
let mockPanelsById: Record<string, TerminalInstance> = {};

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => ({ activeWorktreeId: mockActiveWorktreeId }),
  },
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({ panelIds: mockPanelIds, panelsById: mockPanelsById }),
  },
}));

const { wakeActiveWorktreeTerminals } = await import("@/store/wakeActiveWorktreeTerminals");

function panel(id: string, overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id,
    title: id,
    location: "grid",
    ...overrides,
  } as TerminalInstance;
}

beforeEach(() => {
  fullWakeMock.mockReset();
  fullWakeMock.mockResolvedValue(undefined);
  isFocusedMock.mockReset();
  isFocusedMock.mockReturnValue(false);
  logWarnMock.mockReset();
  mockActiveWorktreeId = null;
  mockPanelIds = [];
  mockPanelsById = {};
});

describe("wakeActiveWorktreeTerminals", () => {
  it("wakes grid terminals in the active worktree", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    const b = panel("b", { worktreeId: "wt-1" });
    mockPanelIds = ["a", "b"];
    mockPanelsById = { a, b };

    await wakeActiveWorktreeTerminals();

    expect(fullWakeMock).toHaveBeenCalledTimes(2);
    expect(fullWakeMock).toHaveBeenCalledWith("a");
    expect(fullWakeMock).toHaveBeenCalledWith("b");
  });

  it("excludes terminals from other worktrees", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    const b = panel("b", { worktreeId: "wt-2" });
    mockPanelIds = ["a", "b"];
    mockPanelsById = { a, b };

    await wakeActiveWorktreeTerminals();

    expect(fullWakeMock).toHaveBeenCalledTimes(1);
    expect(fullWakeMock).toHaveBeenCalledWith("a");
  });

  it("excludes dock-located terminals", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1", location: "grid" });
    const dock = panel("dock", { worktreeId: "wt-1", location: "dock" });
    mockPanelIds = ["a", "dock"];
    mockPanelsById = { a, dock };

    await wakeActiveWorktreeTerminals();

    expect(fullWakeMock).toHaveBeenCalledTimes(1);
    expect(fullWakeMock).toHaveBeenCalledWith("a");
  });

  it("excludes trash-located terminals", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    const trash = panel("trash", { worktreeId: "wt-1", location: "trash" });
    mockPanelIds = ["a", "trash"];
    mockPanelsById = { a, trash };

    await wakeActiveWorktreeTerminals();

    expect(fullWakeMock).toHaveBeenCalledTimes(1);
    expect(fullWakeMock).toHaveBeenCalledWith("a");
  });

  it("excludes non-terminal panel kinds", async () => {
    mockActiveWorktreeId = "wt-1";
    const term = panel("term", { worktreeId: "wt-1", kind: "terminal" });
    const browser = panel("browser", { worktreeId: "wt-1", kind: "browser" });
    const devPreview = panel("dev", { worktreeId: "wt-1", kind: "dev-preview" });
    mockPanelIds = ["term", "browser", "dev"];
    mockPanelsById = { term, browser, dev: devPreview };

    await wakeActiveWorktreeTerminals();

    expect(fullWakeMock).toHaveBeenCalledTimes(1);
    expect(fullWakeMock).toHaveBeenCalledWith("term");
  });

  it("treats undefined kind as terminal", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1", kind: undefined });
    mockPanelIds = ["a"];
    mockPanelsById = { a };

    await wakeActiveWorktreeTerminals();

    expect(fullWakeMock).toHaveBeenCalledTimes(1);
    expect(fullWakeMock).toHaveBeenCalledWith("a");
  });

  it("when no active worktree, only wakes terminals with no worktree affiliation", async () => {
    mockActiveWorktreeId = null;
    const a = panel("a", { worktreeId: undefined });
    const b = panel("b", { worktreeId: "wt-1" });
    mockPanelIds = ["a", "b"];
    mockPanelsById = { a, b };

    await wakeActiveWorktreeTerminals();

    expect(fullWakeMock).toHaveBeenCalledTimes(1);
    expect(fullWakeMock).toHaveBeenCalledWith("a");
  });

  it("no-ops when there are no panels", async () => {
    mockActiveWorktreeId = "wt-1";
    mockPanelIds = [];
    mockPanelsById = {};

    await wakeActiveWorktreeTerminals();

    expect(fullWakeMock).not.toHaveBeenCalled();
  });

  it("skips panels missing from panelsById", async () => {
    mockActiveWorktreeId = "wt-1";
    mockPanelIds = ["ghost"];
    mockPanelsById = {};

    await expect(wakeActiveWorktreeTerminals()).resolves.toBeUndefined();
    expect(fullWakeMock).not.toHaveBeenCalled();
  });

  it("isolates per-terminal failures so the fan-out continues", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    const b = panel("b", { worktreeId: "wt-1" });
    const c = panel("c", { worktreeId: "wt-1" });
    mockPanelIds = ["a", "b", "c"];
    mockPanelsById = { a, b, c };

    fullWakeMock.mockImplementation(async (id: string) => {
      if (id === "b") throw new Error("broken xterm");
    });

    await expect(wakeActiveWorktreeTerminals()).resolves.toBeUndefined();

    expect(fullWakeMock).toHaveBeenCalledTimes(3);
    expect(fullWakeMock).toHaveBeenCalledWith("a");
    expect(fullWakeMock).toHaveBeenCalledWith("b");
    expect(fullWakeMock).toHaveBeenCalledWith("c");
    expect(logWarnMock).toHaveBeenCalledTimes(1);
    expect(logWarnMock).toHaveBeenCalledWith(
      "[wakeActiveWorktreeTerminals] wake failed",
      expect.objectContaining({ id: "b" })
    );
  });

  it("runs the focused panel before the rest", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    const b = panel("b", { worktreeId: "wt-1" });
    const c = panel("c", { worktreeId: "wt-1" });
    mockPanelIds = ["a", "b", "c"];
    mockPanelsById = { a, b, c };

    // "c" is focused — must be invoked first
    isFocusedMock.mockImplementation((id: string) => id === "c");

    const callOrder: string[] = [];
    fullWakeMock.mockImplementation(async (id: string) => {
      callOrder.push(id);
    });

    await wakeActiveWorktreeTerminals();

    expect(callOrder[0]).toBe("c");
    expect(callOrder).toHaveLength(3);
  });

  it("caps concurrent wakes at 2 and actually runs them in parallel", async () => {
    mockActiveWorktreeId = "wt-1";
    const ids = ["a", "b", "c", "d", "e", "f"];
    mockPanelIds = ids;
    mockPanelsById = Object.fromEntries(
      ids.map((id) => [id, panel(id, { worktreeId: "wt-1" })])
    ) as Record<string, TerminalInstance>;

    let inFlight = 0;
    let maxInFlight = 0;
    const deferreds = new Map<string, () => void>();

    fullWakeMock.mockImplementation((id: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<void>((resolve) => {
        deferreds.set(id, () => {
          inFlight--;
          resolve();
        });
      });
    });

    const done = wakeActiveWorktreeTerminals();

    // After the workers have spawned, the pool should have exactly 2 wakes
    // in-flight (proving fan-out, not just serial execution).
    await Promise.resolve();
    await Promise.resolve();
    expect(inFlight).toBe(2);

    let safety = 50;
    while (safety-- > 0) {
      await Promise.resolve();
      await Promise.resolve();
      if (deferreds.size === 0 && inFlight === 0) {
        break;
      }
      const toResolve = [...deferreds.values()];
      deferreds.clear();
      for (const r of toResolve) r();
    }

    await done;

    expect(fullWakeMock).toHaveBeenCalledTimes(6);
    expect(maxInFlight).toBe(2);
  });

  it("a hung focused-panel wake does not block the other panels", async () => {
    mockActiveWorktreeId = "wt-1";
    const a = panel("a", { worktreeId: "wt-1" });
    const b = panel("b", { worktreeId: "wt-1" });
    const c = panel("c", { worktreeId: "wt-1" });
    mockPanelIds = ["a", "b", "c"];
    mockPanelsById = { a, b, c };

    // Focused panel "a" never resolves
    isFocusedMock.mockImplementation((id: string) => id === "a");

    let resolveB!: () => void;
    let resolveC!: () => void;
    fullWakeMock.mockImplementation((id: string) => {
      if (id === "a") return new Promise<void>(() => {}); // hangs forever
      if (id === "b") return new Promise<void>((r) => (resolveB = () => r()));
      if (id === "c") return new Promise<void>((r) => (resolveC = () => r()));
      return Promise.resolve();
    });

    const done = wakeActiveWorktreeTerminals();

    // After microtask flushes, the pool has started a + b (cap=2); c waits.
    await Promise.resolve();
    await Promise.resolve();
    expect(fullWakeMock).toHaveBeenCalledWith("a");
    expect(fullWakeMock).toHaveBeenCalledWith("b");

    // Resolve b → c starts. a is still hung.
    resolveB();
    await Promise.resolve();
    await Promise.resolve();
    expect(fullWakeMock).toHaveBeenCalledWith("c");

    resolveC();
    // done never resolves because a hangs — but b and c made progress.
    // Drop reference; vitest cleanup will handle the pending promise.
    void done;
  });
});
