// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { createStore } from "zustand/vanilla";
import {
  FLEET_BROADCAST_HISTORY_KEY,
  FLEET_CONFIRM_BYTE_THRESHOLD,
  FLEET_DESTRUCTIVE_RE,
  FLEET_LARGE_PASTE_BATCH_SIZE,
  FLEET_LARGE_PASTE_BYTE_THRESHOLD,
  buildFleetBroadcastRecipeContext,
  getFleetBroadcastByteLength,
  getFleetBroadcastWarnings,
  needsFleetBroadcastConfirmation,
  resolveFleetBroadcastTargetIds,
} from "../fleetBroadcast";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import { setCurrentViewStore } from "@/store/createWorktreeStore";
import type { WorktreeViewState, WorktreeViewActions } from "@/store/createWorktreeStore";
import type { TerminalInstance, WorktreeSnapshot } from "@shared/types";

function resetStores() {
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
  });
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
}

function seedPanels(terminals: TerminalInstance[]): void {
  const panelsById: Record<string, TerminalInstance> = {};
  const panelIds: string[] = [];
  for (const t of terminals) {
    panelsById[t.id] = t;
    panelIds.push(t.id);
  }
  usePanelStore.setState({ panelsById, panelIds });
}

function makeAgent(id: string, overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id,
    title: id,
    type: "terminal",
    kind: "terminal",
    agentId: "claude",
    worktreeId: "wt-1",
    projectId: "proj-1",
    location: "grid",
    agentState: "idle",
    hasPty: true,
    ...(overrides as object),
  } as TerminalInstance;
}

function makeWorktree(id: string, overrides: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return {
    id,
    worktreeId: id,
    path: `/tmp/${id}`,
    name: id,
    branch: `feature/${id}`,
    isCurrent: false,
    issueNumber: 42,
    prNumber: 101,
    ...(overrides as object),
  } as WorktreeSnapshot;
}

function installViewStore(worktrees: Map<string, WorktreeSnapshot>) {
  const store = createStore<WorktreeViewState & WorktreeViewActions>(() => ({
    worktrees,
    version: 0,
    isLoading: false,
    error: null,
    isInitialized: true,
    isReconnecting: false,
    nextVersion: () => 0,
    applySnapshot: () => {},
    applyUpdate: () => {},
    applyRemove: () => {},
    setLoading: () => {},
    setError: () => {},
    setFatalError: () => {},
    setReconnecting: () => {},
  }));
  setCurrentViewStore(store);
}

describe("fleetBroadcast constants", () => {
  it("history key is stable", () => {
    expect(FLEET_BROADCAST_HISTORY_KEY).toBe("fleet-broadcast");
  });
  it("confirmation threshold matches spec (512 bytes)", () => {
    expect(FLEET_CONFIRM_BYTE_THRESHOLD).toBe(512);
  });
  it("large-paste byte threshold matches spec (100 KB)", () => {
    expect(FLEET_LARGE_PASTE_BYTE_THRESHOLD).toBe(102_400);
  });
  it("large-paste batch size is a conservative IPC fan-out", () => {
    expect(FLEET_LARGE_PASTE_BATCH_SIZE).toBe(5);
  });
});

describe("FLEET_DESTRUCTIVE_RE", () => {
  const positives = [
    "rm -rf /tmp/foo",
    "rm -r ./build",
    "rm -f something",
    "rm -rfv node_modules",
    "rm -Rf /tmp/foo",
    "git clean -fd",
    "git clean -fdx",
    "sudo apt install",
    "drop table users",
    "DROP TABLE USERS",
    "truncate table sessions",
    "chmod -R 777 /",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda",
    ":(){ :|:& };:",
  ];
  for (const cmd of positives) {
    it(`flags: ${cmd}`, () => {
      expect(FLEET_DESTRUCTIVE_RE.test(cmd)).toBe(true);
    });
  }

  const negatives = [
    "echo hello",
    "git status",
    "npm test",
    "ls -la",
    "echo 'drop it'",
    "please rm the unused code",
  ];
  for (const cmd of negatives) {
    it(`does not flag: ${cmd}`, () => {
      expect(FLEET_DESTRUCTIVE_RE.test(cmd)).toBe(false);
    });
  }
});

describe("getFleetBroadcastByteLength", () => {
  it("counts ASCII bytes", () => {
    expect(getFleetBroadcastByteLength("hello")).toBe(5);
  });
  it("counts multi-byte UTF-8 characters (emoji = 4 bytes)", () => {
    expect(getFleetBroadcastByteLength("✓")).toBe(3);
    expect(getFleetBroadcastByteLength("🚀")).toBe(4);
  });
});

describe("getFleetBroadcastWarnings", () => {
  it("detects multi-line payloads", () => {
    expect(getFleetBroadcastWarnings("one\ntwo").multiline).toBe(true);
    expect(getFleetBroadcastWarnings("one two").multiline).toBe(false);
  });

  it("detects byte-length overflow", () => {
    const small = "a".repeat(FLEET_CONFIRM_BYTE_THRESHOLD);
    const large = "a".repeat(FLEET_CONFIRM_BYTE_THRESHOLD + 1);
    expect(getFleetBroadcastWarnings(small).overByteLimit).toBe(false);
    expect(getFleetBroadcastWarnings(large).overByteLimit).toBe(true);
  });

  it("counts UTF-8 bytes — 509 ASCII + rocket (4 bytes) crosses to 513", () => {
    const borderline = "a".repeat(FLEET_CONFIRM_BYTE_THRESHOLD - 3) + "🚀";
    expect(getFleetBroadcastByteLength(borderline)).toBe(FLEET_CONFIRM_BYTE_THRESHOLD + 1);
    expect(getFleetBroadcastWarnings(borderline).overByteLimit).toBe(true);
  });

  it("treats exactly 512 UTF-8 bytes as within limit", () => {
    const exact = "a".repeat(FLEET_CONFIRM_BYTE_THRESHOLD - 4) + "🚀";
    expect(getFleetBroadcastByteLength(exact)).toBe(FLEET_CONFIRM_BYTE_THRESHOLD);
    expect(getFleetBroadcastWarnings(exact).overByteLimit).toBe(false);
  });

  it("detects destructive commands", () => {
    expect(getFleetBroadcastWarnings("rm -rf node_modules").destructive).toBe(true);
    expect(getFleetBroadcastWarnings("echo 'hi'").destructive).toBe(false);
  });
});

describe("needsFleetBroadcastConfirmation", () => {
  it("returns true when any warning fires", () => {
    expect(needsFleetBroadcastConfirmation("multi\nline")).toBe(true);
    expect(needsFleetBroadcastConfirmation("rm -rf .")).toBe(true);
    expect(needsFleetBroadcastConfirmation("x".repeat(700))).toBe(true);
  });
  it("returns false for short, single-line, safe text", () => {
    expect(needsFleetBroadcastConfirmation("run the test")).toBe(false);
  });
});

describe("resolveFleetBroadcastTargetIds", () => {
  beforeEach(() => {
    resetStores();
  });

  it("returns empty array when nothing is armed", () => {
    expect(resolveFleetBroadcastTargetIds()).toEqual([]);
  });

  it("drops trashed/background/non-pty terminals silently", () => {
    seedPanels([
      makeAgent("ok"),
      makeAgent("trashed", { location: "trash" }),
      makeAgent("bg", { location: "background" }),
      makeAgent("noPty", { hasPty: false }),
    ]);
    useFleetArmingStore.getState().armIds(["ok", "trashed", "bg", "noPty"]);
    expect(resolveFleetBroadcastTargetIds()).toEqual(["ok"]);
  });

  it("preserves armOrder ordering", () => {
    seedPanels([makeAgent("a"), makeAgent("b"), makeAgent("c")]);
    useFleetArmingStore.getState().armIds(["c", "a", "b"]);
    expect(resolveFleetBroadcastTargetIds()).toEqual(["c", "a", "b"]);
  });

  it("drops ids that no longer exist in panel store", () => {
    seedPanels([makeAgent("a")]);
    useFleetArmingStore.getState().armIds(["a", "ghost"]);
    expect(resolveFleetBroadcastTargetIds()).toEqual(["a"]);
  });

  it("excludes a plain terminal running a detected agent", () => {
    seedPanels([
      makeAgent("a"),
      makeAgent("p", {
        kind: "terminal",
        agentId: undefined,
        detectedAgentId: "claude",
      }),
    ]);
    useFleetArmingStore.getState().armIds(["a", "p"]);
    expect(resolveFleetBroadcastTargetIds()).toEqual(["a"]);
  });

  it("excludes a plain terminal after detected agent exits", () => {
    seedPanels([
      makeAgent("a"),
      makeAgent("p", {
        kind: "terminal",
        agentId: undefined,
        detectedAgentId: undefined,
        everDetectedAgent: true,
      }),
    ]);
    useFleetArmingStore.getState().armIds(["a", "p"]);
    expect(resolveFleetBroadcastTargetIds()).toEqual(["a"]);
  });
});

describe("buildFleetBroadcastRecipeContext", () => {
  beforeEach(() => {
    resetStores();
    const worktrees = new Map<string, WorktreeSnapshot>();
    worktrees.set(
      "wt-1",
      makeWorktree("wt-1", {
        path: "/repo/wt-1",
        branch: "feature/x",
        issueNumber: 7,
        prNumber: 9,
      })
    );
    installViewStore(worktrees);
  });

  it("resolves the context fields from the worktree store", () => {
    seedPanels([makeAgent("t1", { worktreeId: "wt-1" })]);
    const ctx = buildFleetBroadcastRecipeContext("t1");
    expect(ctx).toEqual({
      issueNumber: 7,
      prNumber: 9,
      worktreePath: "/repo/wt-1",
      branchName: "feature/x",
    });
  });

  it("returns null for unknown terminal id", () => {
    expect(buildFleetBroadcastRecipeContext("missing")).toBeNull();
  });

  it("returns null when panel has no worktreeId", () => {
    seedPanels([makeAgent("orphan", { worktreeId: undefined as unknown as string })]);
    expect(buildFleetBroadcastRecipeContext("orphan")).toBeNull();
  });

  it("returns null when worktree missing from view store", () => {
    seedPanels([makeAgent("t2", { worktreeId: "wt-missing" })]);
    expect(buildFleetBroadcastRecipeContext("t2")).toBeNull();
  });

  it("falls back to worktree.name when branch is unset", () => {
    const worktrees = new Map<string, WorktreeSnapshot>();
    worktrees.set("wt-x", makeWorktree("wt-x", { branch: undefined, name: "fallback-name" }));
    installViewStore(worktrees);
    seedPanels([makeAgent("t3", { worktreeId: "wt-x" })]);
    expect(buildFleetBroadcastRecipeContext("t3")?.branchName).toBe("fallback-name");
  });
});
