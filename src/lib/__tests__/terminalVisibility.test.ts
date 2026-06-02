import { describe, it, expect, vi } from "vitest";
import { isTerminalOrphaned, isTerminalVisible } from "@/lib/terminalVisibility";
import type { PtyPanelData } from "@shared/types/panel";

function makeTerminal(overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id: "t1",
    worktreeId: "wt1",
    location: "grid" as const,
    excludeFromPersistence: false,
    agentState: "working",
    ...overrides,
  } as PtyPanelData;
}

describe("isTerminalOrphaned", () => {
  it("returns false when terminal has no worktreeId", () => {
    const t = makeTerminal({ worktreeId: "" });
    expect(isTerminalOrphaned(t, new Set(["other"]))).toBe(false);
  });

  it("returns false when worktreeIds is empty", () => {
    const t = makeTerminal({ worktreeId: "wt1" });
    expect(isTerminalOrphaned(t, new Set())).toBe(false);
  });

  it("returns false when worktreeId is in the set", () => {
    const t = makeTerminal({ worktreeId: "wt1" });
    expect(isTerminalOrphaned(t, new Set(["wt1", "wt2"]))).toBe(false);
  });

  it("returns true when worktreeId is not in the set", () => {
    const t = makeTerminal({ worktreeId: "wt1" });
    expect(isTerminalOrphaned(t, new Set(["wt2", "wt3"]))).toBe(true);
  });
});

describe("isTerminalVisible", () => {
  const isInTrash = vi.fn().mockReturnValue(false);
  const worktreeIds = new Set(["wt1"]);

  it("returns true for a visible terminal", () => {
    const t = makeTerminal();
    expect(isTerminalVisible(t, isInTrash, worktreeIds)).toBe(true);
  });

  it("returns false when isInTrash returns true", () => {
    const t = makeTerminal({ id: "t-trash" });
    const trashFn = vi.fn().mockImplementation((id: string) => id === "t-trash");
    expect(isTerminalVisible(t, trashFn, worktreeIds)).toBe(false);
  });

  it("returns false for location === trash", () => {
    const t = makeTerminal({ location: "trash" });
    expect(isTerminalVisible(t, isInTrash, worktreeIds)).toBe(false);
  });

  it("returns false for location === background", () => {
    const t = makeTerminal({ location: "background" });
    expect(isTerminalVisible(t, isInTrash, worktreeIds)).toBe(false);
  });

  it("returns false for excludeFromPersistence terminals", () => {
    const t = makeTerminal({ excludeFromPersistence: true });
    expect(isTerminalVisible(t, isInTrash, worktreeIds)).toBe(false);
  });

  it("stays visible for removeOnExit-only terminals (flags are independent)", () => {
    const t = makeTerminal({ removeOnExit: true, excludeFromPersistence: false });
    expect(isTerminalVisible(t, isInTrash, worktreeIds)).toBe(true);
  });

  it("returns false for orphaned terminals", () => {
    const t = makeTerminal({ worktreeId: "nonexistent" });
    expect(isTerminalVisible(t, isInTrash, worktreeIds)).toBe(false);
  });
});
