/**
 * Regression test for #10512: the non-PTY `addPanel` branch must apply the same
 * "active worktree not yet hydrated" null guard the PTY branch has. Without it, a
 * non-PTY plugin panel spawned with an explicit `worktreeId` while the worktree
 * store is still null (common mid project-switch) is mis-classified as "not in
 * the active worktree" and backgrounded instead of running.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
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
  },
}));

vi.mock("../persistence", async () => {
  const actual = await vi.importActual<typeof import("../persistence")>("../persistence");
  return {
    ...actual,
    saveNormalized: vi.fn(),
  };
});

// Drive the active-worktree snapshot per-test so we can simulate the
// not-yet-hydrated (null) state the guard exists for.
let activeWorktreeId: string | null = null;
vi.mock("@/store/storeAccessors", async () => {
  const actual =
    await vi.importActual<typeof import("@/store/storeAccessors")>("@/store/storeAccessors");
  return {
    ...actual,
    getWorktreeSelectionSnapshot: () => ({ activeWorktreeId }),
  };
});

beforeEach(() => {
  (globalThis as { window?: unknown }).window = {
    electron: {
      globalEnv: {
        get: vi.fn().mockResolvedValue({}),
      },
    },
  };
});

const { usePanelStore } = await import("../../../panelStore");

// Plugin panels are cast into the carrier, and runtimeStatus is set at runtime
// by addPanel for every kind even though it isn't declared on every
// PanelInstance variant — read it through a structural shape.
function getPanel(id: string): { runtimeStatus?: string } | undefined {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- carrier read; runtimeStatus is set at runtime on every kind
  return usePanelStore.getState().panelsById[id] as { runtimeStatus?: string } | undefined;
}

// Extension panel kinds are intentionally excluded from the AddPanelOptions
// union (a `kind: string` member would defeat discriminated-union narrowing for
// built-in kinds), so spawning a plugin kind widens at the call boundary — the
// same documented pattern used by panel.openPluginPanel.
type AddPanelFn = ReturnType<typeof usePanelStore.getState>["addPanel"];
function spawnPlugin(
  addPanel: AddPanelFn,
  options: Record<string, unknown>
): Promise<string | null> {
  return addPanel(options as Parameters<AddPanelFn>[0]);
}

describe("addPanel non-PTY active-worktree null guard (#10512)", () => {
  beforeEach(async () => {
    activeWorktreeId = null;
    const { reset } = usePanelStore.getState();
    await reset();
  });

  it("keeps a non-PTY plugin panel running when the active worktree is not yet hydrated", async () => {
    activeWorktreeId = null; // worktree store still null (mid project-switch)
    const { addPanel } = usePanelStore.getState();
    const id = await spawnPlugin(addPanel, {
      kind: "acme.notes",
      worktreeId: "wt-1",
      requestedId: "plugin-1",
      location: "grid",
      bypassLimits: true,
    });

    expect(id).toBe("plugin-1");
    expect(getPanel("plugin-1")?.runtimeStatus).toBe("running");
    // The panel must also be indexed under its worktree so the grid can find it.
    expect(usePanelStore.getState().panelIdsByWorktreeId["wt-1"]).toContain("plugin-1");
  });

  it("backgrounds a non-PTY plugin panel that belongs to a different, hydrated worktree", async () => {
    activeWorktreeId = "wt-active"; // worktree store hydrated, panel is elsewhere
    const { addPanel } = usePanelStore.getState();
    const id = await spawnPlugin(addPanel, {
      kind: "acme.notes",
      worktreeId: "wt-other",
      requestedId: "plugin-2",
      location: "grid",
      bypassLimits: true,
    });

    expect(id).toBe("plugin-2");
    expect(getPanel("plugin-2")?.runtimeStatus).toBe("background");
  });
});
