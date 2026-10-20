/**
 * A panel born parked (`location: "background"`, #13661) must carry its restore
 * entry from its very first commit: `restoreBackgroundTerminal` reads only
 * `backgroundedTerminals`, so a parked panel without one could never be brought
 * back. It must also never take focus or mount in the grid on the way in.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PanelInstance } from "@shared/types/panel";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: {
    setState: vi.fn().mockResolvedValue(undefined),
  },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({}),
  },
  globalEnvClient: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn(),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
  systemClient: {
    getAppMetrics: vi.fn().mockResolvedValue({ totalMemoryMB: 512 }),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
    prewarmTerminal: vi.fn(),
    setInputLocked: vi.fn(),
    sendPtyResize: vi.fn(),
    waitForAttachSettled: vi.fn().mockResolvedValue(undefined),
    wake: vi.fn(),
    invalidatePtyGrid: vi.fn(),
    get: vi.fn(() => null),
  },
}));

vi.mock("../persistence", async () => {
  const actual = await vi.importActual<typeof import("../persistence")>("../persistence");
  return { ...actual, saveNormalized: vi.fn() };
});

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    electron: { globalEnv: { get: vi.fn().mockResolvedValue({}) } },
  };
});

const { usePanelStore } = await import("../../../panelStore");
const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
const { TerminalRefreshTier } = await import("@/types");
const { saveNormalized } = await import("../persistence");

type Snapshot = {
  location: string | undefined;
  entry: { originalLocation: string } | undefined;
};

/** Every committed state the panel appeared in, in order. */
function recordCommits(id: string): { commits: Snapshot[]; stop: () => void } {
  const commits: Snapshot[] = [];
  const stop = usePanelStore.subscribe((state) => {
    const panel = state.panelsById[id];
    if (!panel) return;
    commits.push({ location: panel.location, entry: state.backgroundedTerminals.get(id) });
  });
  return { commits, stop };
}

describe("addPanel with location: background (#13661)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await usePanelStore.getState().reset();
  });

  it("commits a PTY panel parked, with its grid restore entry, from the first commit", async () => {
    usePanelStore.setState({ focusedId: "other" });
    const { commits, stop } = recordCommits("bg-1");

    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "bg-1",
      cwd: "/tmp",
      location: "background",
    });
    stop();

    expect(commits.length).toBeGreaterThan(0);
    for (const commit of commits) {
      expect(commit.location).toBe("background");
      expect(commit.entry?.originalLocation).toBe("grid");
    }

    const state = usePanelStore.getState();
    const panel = state.panelsById["bg-1"] as
      (PanelInstance & { runtimeStatus?: string }) | undefined;
    expect(panel?.isVisible).toBe(false);
    expect(panel?.runtimeStatus).toBe("background");
    expect(panel?.backgroundRestoreLocation).toBe("grid");
    expect(state.panelIds).toContain("bg-1");
    expect(state.focusedId).toBe("other");
    expect(terminalInstanceService.applyRendererPolicy).toHaveBeenCalledWith(
      "bg-1",
      TerminalRefreshTier.BACKGROUND
    );
    expect(terminalInstanceService.sendPtyResize).not.toHaveBeenCalled();
  });

  it("restores a born-parked panel to its recorded target", async () => {
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "bg-dock",
      cwd: "/tmp",
      location: "background",
      backgroundRestoreLocation: "dock",
    });
    expect(usePanelStore.getState().backgroundedTerminals.get("bg-dock")?.originalLocation).toBe(
      "dock"
    );

    usePanelStore.getState().restoreBackgroundTerminal("bg-dock");

    const state = usePanelStore.getState();
    expect(state.panelsById["bg-dock"]?.location).toBe("dock");
    expect(state.backgroundedTerminals.has("bg-dock")).toBe(false);
  });

  it("keeps an existing restore entry when a hydration replays the same parked panel", async () => {
    const groupMetadata = {
      panelIds: ["bg-2", "sibling"],
      activeTabId: "bg-2",
      location: "grid" as const,
      worktreeId: null,
    };
    usePanelStore.setState({
      backgroundedTerminals: new Map([
        [
          "bg-2",
          { id: "bg-2", originalLocation: "grid", groupRestoreId: "group-x", groupMetadata },
        ],
      ]),
    });

    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "bg-2",
      cwd: "/tmp",
      location: "background",
      backgroundRestoreLocation: "dock",
    });

    expect(usePanelStore.getState().backgroundedTerminals.get("bg-2")).toEqual({
      id: "bg-2",
      originalLocation: "grid",
      groupRestoreId: "group-x",
      groupMetadata,
    });
    // The panel's own target follows the kept entry, so a later save can't
    // send it somewhere a restore in this session wouldn't.
    expect(usePanelStore.getState().panelsById["bg-2"]?.backgroundRestoreLocation).toBe("grid");
    // ...including the record handed to persistence inside the commit.
    const saved = vi.mocked(saveNormalized).mock.calls.at(-1)?.[0]["bg-2"];
    expect(saved?.backgroundRestoreLocation).toBe("grid");
  });

  it("parks an agent without resizing its PTY to an active-grid estimate", async () => {
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      launchAgentId: "claude",
      requestedId: "bg-agent",
      cwd: "/tmp",
      location: "background",
    });

    const state = usePanelStore.getState();
    expect(state.panelsById["bg-agent"]?.location).toBe("background");
    expect(state.backgroundedTerminals.get("bg-agent")?.originalLocation).toBe("grid");
    expect(terminalInstanceService.prewarmTerminal).toHaveBeenCalled();
    expect(terminalInstanceService.sendPtyResize).not.toHaveBeenCalled();
  });

  it("seeds the restore entry on the batched hydration commit, before the ids flush", async () => {
    const { beginHydrationBatch, flushHydrationBatch } = usePanelStore.getState();
    const token = beginHydrationBatch();

    await usePanelStore.getState().addPanel({
      kind: "terminal",
      existingId: "bg-batch",
      cwd: "/tmp",
      location: "background",
      backgroundRestoreLocation: "dock",
    });

    const mid = usePanelStore.getState();
    expect(mid.panelsById["bg-batch"]?.location).toBe("background");
    expect(mid.backgroundedTerminals.get("bg-batch")?.originalLocation).toBe("dock");
    expect(mid.panelIds).not.toContain("bg-batch");

    flushHydrationBatch(token);
    expect(usePanelStore.getState().panelIds).toContain("bg-batch");

    usePanelStore.getState().restoreBackgroundTerminal("bg-batch");
    expect(usePanelStore.getState().panelsById["bg-batch"]?.location).toBe("dock");
  });

  it("drops the restore entry when a parked panel is moved out by another route", async () => {
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "bg-move",
      cwd: "/tmp",
      location: "background",
    });

    usePanelStore.getState().moveTerminalToDock("bg-move");

    const state = usePanelStore.getState();
    expect(state.panelsById["bg-move"]?.location).toBe("dock");
    expect(state.backgroundedTerminals.has("bg-move")).toBe(false);
  });

  it("writes no restore entry for a panel placed on the grid", async () => {
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "grid-1",
      cwd: "/tmp",
      location: "grid",
      focusPolicy: "preserve",
    });

    const state = usePanelStore.getState();
    expect(state.panelsById["grid-1"]?.location).toBe("grid");
    expect(state.panelsById["grid-1"]?.backgroundRestoreLocation).toBeUndefined();
    expect(state.backgroundedTerminals.has("grid-1")).toBe(false);
  });

  it("records the restore target on the panel when an existing panel is parked", async () => {
    await usePanelStore.getState().addPanel({
      kind: "terminal",
      requestedId: "dock-1",
      cwd: "/tmp",
      location: "dock",
      focusPolicy: "preserve",
    });

    usePanelStore.getState().backgroundTerminal("dock-1");

    expect(usePanelStore.getState().panelsById["dock-1"]?.backgroundRestoreLocation).toBe("dock");
  });
});
