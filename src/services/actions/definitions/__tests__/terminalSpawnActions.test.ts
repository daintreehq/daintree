import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { AddPanelOptions } from "@/store/slices/panelRegistry/types";

const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const pushLayoutSnapshotMock = vi.hoisted(() => vi.fn());
const layoutUndoMock = vi.hoisted(() => ({
  getState: vi.fn(() => ({ pushLayoutSnapshot: pushLayoutSnapshotMock })),
}));
const moveTerminalToWorktreeAndFollowRescueMock = vi.hoisted(() => vi.fn());
const buildPanelDuplicateOptionsMock = vi.hoisted(() => vi.fn());
const resolveInheritedPanelCwdMock = vi.hoisted(() => vi.fn());
const flushOptimisticClosesMock = vi.hoisted(() => vi.fn());
const buildResumePanelOptionsMock = vi.hoisted(() => vi.fn());
const listAgentSessionsMock = vi.hoisted(() => vi.fn());

vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
vi.mock("@/store/layoutUndoStore", () => ({ useLayoutUndoStore: layoutUndoMock }));
vi.mock("@/services/terminal/panelDuplicationService", () => ({
  buildPanelDuplicateOptions: buildPanelDuplicateOptionsMock,
  resolveInheritedPanelCwd: resolveInheritedPanelCwdMock,
  panelKindHasLaunchRoot: (kind: string | undefined) =>
    kind === "terminal" || kind === "dev-preview",
}));
vi.mock("@/services/terminal/optimisticPanelClose", () => ({
  flushOptimisticCloses: flushOptimisticClosesMock,
}));
vi.mock("@/services/terminal/crossWorktreeMove", () => ({
  moveTerminalToWorktreeAndFollowRescue: moveTerminalToWorktreeAndFollowRescueMock,
}));
vi.mock("@/services/agentResume", () => ({
  buildResumePanelOptions: buildResumePanelOptionsMock,
}));

vi.mock("@shared/config/panelKindRegistry", () => ({
  getPanelKindConfig: (kind: string) => {
    if (kind === "terminal")
      return { id: kind, name: "Terminal", iconId: "terminal", color: "#aaa" };
    if (kind === "browser") return { id: kind, name: "Browser", iconId: "globe", color: "#aaa" };
    if (kind === "notes") return { id: kind, name: "Notes", iconId: "notes", color: "#aaa" };
    if (kind === "dev-preview")
      return { id: kind, name: "Dev Preview", iconId: "monitor-play", color: "#aaa" };
    return {
      id: kind,
      name: kind.charAt(0).toUpperCase() + kind.slice(1),
      iconId: kind,
      color: "#aaa",
    };
  },
  getPanelKindColor: () => "#aaa",
  getDefaultPanelTitle: (kind: string, agentId?: string) => {
    // Agent identity takes precedence, matching production behavior
    if (agentId === "claude") return "Claude";
    if (agentId === "gemini") return "Gemini";
    if (kind === "terminal") return "Terminal";
    if (kind === "browser") return "Browser";
    if (kind === "notes") return "Notes";
    if (kind === "dev-preview") return "Dev Preview";
    return kind.charAt(0).toUpperCase() + kind.slice(1);
  },
}));

import { registerTerminalSpawnActions } from "../terminalSpawnActions";

function setupActions(overrides?: { activeWorktreeId?: string | undefined }) {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {
    getDefaultCwd: () => "/cwd",
    getActiveWorktreeId: () =>
      "activeWorktreeId" in (overrides ?? {}) ? overrides!.activeWorktreeId : "wt-1",
  } as unknown as ActionCallbacks;
  registerTerminalSpawnActions(actions, callbacks);
  return async (id: string, args?: unknown, ctx?: unknown): Promise<unknown> => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    const def = factory() as AnyActionDefinition;
    return def.run(args, (ctx ?? {}) as never);
  };
}

type MockPanel = {
  id: string;
  location: "grid" | "dock" | "trash";
  kind?: "terminal" | "browser" | "notes" | "dev-preview";
  launchAgentId?: string;
  detectedAgentId?: string;
  title?: string;
  agentSessionId?: string;
  worktreeId?: string;
};

function setPanelState(options: {
  focusedId?: string | null;
  panels?: MockPanel[];
  addPanel?: ReturnType<typeof vi.fn>;
  lastClosedConfig?: AddPanelOptions | null;
  restoreLastTrashed?: ReturnType<typeof vi.fn>;
  activateTerminal?: ReturnType<typeof vi.fn>;
  moveToNewWorktree?: ReturnType<typeof vi.fn>;
}) {
  const panels = options.panels ?? [];
  const panelsById: Record<string, MockPanel> = {};
  for (const p of panels) panelsById[p.id] = p;
  panelStoreMock.getState.mockReturnValue({
    focusedId: options.focusedId ?? null,
    panelIds: panels.map((p) => p.id),
    panelsById,
    addPanel: options.addPanel ?? vi.fn().mockResolvedValue(undefined),
    lastClosedConfig: options.lastClosedConfig ?? null,
    restoreLastTrashed: options.restoreLastTrashed ?? vi.fn().mockReturnValue(false),
    activateTerminal: options.activateTerminal ?? vi.fn(),
    moveToNewWorktree: options.moveToNewWorktree ?? vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  listAgentSessionsMock.mockResolvedValue([]);
  (globalThis as unknown as { window: { electron: unknown } }).window = {
    ...(globalThis as unknown as { window?: object }).window,
    electron: { agentSessionHistory: { list: listAgentSessionsMock } },
  };
  // Mirror the real buildPanelDuplicateOptions: browser panels don't carry a title
  // into the returned options (see panelDuplicationService.ts). All other kinds
  // seed options.title from the source panel.
  buildPanelDuplicateOptionsMock.mockImplementation(
    async (panel: MockPanel, location: "grid" | "dock") => {
      const kind = panel.kind ?? "terminal";
      const base = {
        kind,
        launchAgentId: panel.launchAgentId,
        location,
        cwd: "",
      };
      if (kind === "browser" || kind === "dev-preview") return base;
      return { ...base, title: panel.title };
    }
  );
  resolveInheritedPanelCwdMock.mockImplementation(
    (panel: { cwd?: string; worktreeId?: string }) => panel.cwd ?? ""
  );
});

describe("terminal.duplicate (copy) suffix", () => {
  it("terminal.new preserves spawnedBy for MCP-origin launches", async () => {
    const addPanel = vi.fn().mockResolvedValue("p-new");
    setPanelState({ panels: [], addPanel });
    const run = setupActions();

    await run("terminal.new", { spawnedBy: "mcp" });

    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "terminal",
        spawnedBy: "mcp",
      })
    );
  });

  it("terminal.duplicate preserves spawnedBy for MCP-origin duplicated agent panels", async () => {
    const addPanel = vi.fn().mockResolvedValue(undefined);
    setPanelState({
      focusedId: "p1",
      panels: [
        {
          id: "p1",
          location: "grid",
          kind: "terminal",
          launchAgentId: "claude",
          title: "Claude",
        },
      ],
      addPanel,
    });
    const run = setupActions();

    await run("terminal.duplicate", { spawnedBy: "mcp" });

    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        launchAgentId: "claude",
        spawnedBy: "mcp",
      })
    );
  });

  it("does not append (copy) when agent panel title matches the default", async () => {
    const addPanel = vi.fn().mockResolvedValue(undefined);
    setPanelState({
      focusedId: "p1",
      panels: [
        {
          id: "p1",
          location: "grid",
          kind: "terminal",
          launchAgentId: "claude",
          detectedAgentId: "claude",
          title: "Claude",
        },
      ],
      addPanel,
    });
    const run = setupActions();
    await run("terminal.duplicate");

    expect(addPanel).toHaveBeenCalledTimes(1);
    expect(addPanel.mock.calls[0]![0].title).toBe("Claude");
  });

  it("appends (copy) when agent panel title is user-customized", async () => {
    const addPanel = vi.fn().mockResolvedValue(undefined);
    setPanelState({
      focusedId: "p1",
      panels: [
        {
          id: "p1",
          location: "grid",
          kind: "terminal",
          launchAgentId: "claude",
          title: "API work",
        },
      ],
      addPanel,
    });
    const run = setupActions();
    await run("terminal.duplicate");

    expect(addPanel.mock.calls[0]![0].title).toBe("API work (copy)");
  });

  it("does not append (copy) for a default-titled terminal panel", async () => {
    const addPanel = vi.fn().mockResolvedValue(undefined);
    setPanelState({
      focusedId: "p1",
      panels: [{ id: "p1", location: "grid", kind: "terminal", title: "Terminal" }],
      addPanel,
    });
    const run = setupActions();
    await run("terminal.duplicate");

    expect(addPanel.mock.calls[0]![0].title).toBe("Terminal");
  });

  it("appends (copy) when Gemini panel is renamed", async () => {
    const addPanel = vi.fn().mockResolvedValue(undefined);
    setPanelState({
      focusedId: "p1",
      panels: [
        {
          id: "p1",
          location: "grid",
          kind: "terminal",
          launchAgentId: "gemini",
          title: "Refactor run",
        },
      ],
      addPanel,
    });
    const run = setupActions();
    await run("terminal.duplicate");

    expect(addPanel.mock.calls[0]![0].title).toBe("Refactor run (copy)");
  });

  it("leaves title untouched when source panel has no title", async () => {
    const addPanel = vi.fn().mockResolvedValue(undefined);
    setPanelState({
      focusedId: "p1",
      panels: [{ id: "p1", location: "grid", kind: "terminal" }],
      addPanel,
    });
    const run = setupActions();
    await run("terminal.duplicate");

    expect(addPanel.mock.calls[0]![0].title).toBeUndefined();
  });

  it("re-resolves runtime settings for last closed agent snapshots", async () => {
    const addPanel = vi.fn().mockResolvedValue(undefined);
    buildPanelDuplicateOptionsMock.mockResolvedValueOnce({
      kind: "terminal",
      launchAgentId: "claude",
      command: "generated-claude-command",
      agentPresetId: "blue-provider",
      agentPresetColor: "#3366ff",
      env: { ANTHROPIC_BASE_URL: "https://proxy.example" },
    });
    setPanelState({
      panels: [],
      addPanel,
      lastClosedConfig: {
        kind: "terminal",
        launchAgentId: "claude",
        command: "claude --model opus",
        cwd: "/project",
        agentPresetId: "blue-provider",
        agentPresetColor: "#3366ff",
      },
    });

    const run = setupActions();
    await run("terminal.duplicate");

    expect(buildPanelDuplicateOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "last-closed",
        launchAgentId: "claude",
        agentPresetId: "blue-provider",
      }),
      "grid"
    );
    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "generated-claude-command",
        agentPresetId: "blue-provider",
        agentPresetColor: "#3366ff",
        env: { ANTHROPIC_BASE_URL: "https://proxy.example" },
        location: "grid",
        worktreeId: "wt-1",
      })
    );
  });

  it("re-derives a reopened panel's cwd from the worktree it ends up filed under", async () => {
    // Snapshot the cwd as `addPanel` saw it: production hands the same object to
    // the resolver and to `addPanel`, so inspecting the retained reference would
    // still show a corrected value even if the two statements were swapped.
    let cwdAtAddPanel: string | undefined;
    const addPanel = vi.fn((options: AddPanelOptions) => {
      cwdAtAddPanel = options.cwd;
      return Promise.resolve(undefined);
    });
    const pathsByWorktree: Record<string, string> = { "wt-1": "/worktrees/active" };
    let worktreeIdAtResolve: string | undefined;
    resolveInheritedPanelCwdMock.mockImplementation(
      (panel: { cwd?: string; worktreeId?: string }) => {
        worktreeIdAtResolve = panel.worktreeId;
        return (panel.worktreeId && pathsByWorktree[panel.worktreeId]) || panel.cwd || "";
      }
    );
    setPanelState({
      panels: [],
      addPanel,
      // No worktreeId, so the action adopts the active worktree while `cwd`
      // still points at the closed panel's directory.
      lastClosedConfig: { kind: "terminal", command: "bash", cwd: "/worktrees/stale" },
    });

    const run = setupActions();
    await run("terminal.duplicate");

    // The resolver must see the id that actually won, not the snapshot's.
    expect(worktreeIdAtResolve).toBe("wt-1");
    expect(cwdAtAddPanel).toBe(pathsByWorktree["wt-1"]);
  });

  it("resolves a reopened panel against its own worktree when the snapshot kept one", async () => {
    const addPanel = vi.fn().mockResolvedValue(undefined);
    let worktreeIdAtResolve: string | undefined;
    resolveInheritedPanelCwdMock.mockImplementation((panel: { worktreeId?: string }) => {
      worktreeIdAtResolve = panel.worktreeId;
      return "/worktrees/saved";
    });
    setPanelState({
      panels: [],
      addPanel,
      lastClosedConfig: {
        kind: "terminal",
        command: "bash",
        cwd: "/worktrees/stale",
        worktreeId: "wt-saved",
      },
    });

    const run = setupActions();
    await run("terminal.duplicate");

    // A saved id outranks the active worktree, so resolution must key off it.
    expect(worktreeIdAtResolve).toBe("wt-saved");
    expect((addPanel.mock.calls[0]![0] as AddPanelOptions).cwd).toBe("/worktrees/saved");
  });

  it("re-derives a reopened dev-preview's cwd too, since it spawns a dev server", async () => {
    const addPanel = vi.fn().mockResolvedValue(undefined);
    resolveInheritedPanelCwdMock.mockReturnValue("/worktrees/active");
    setPanelState({
      panels: [],
      addPanel,
      lastClosedConfig: {
        kind: "dev-preview",
        devCommand: "npm run dev",
        cwd: "/worktrees/stale",
      },
    });

    const run = setupActions();
    await run("terminal.duplicate");

    expect(resolveInheritedPanelCwdMock).toHaveBeenCalled();
    expect((addPanel.mock.calls[0]![0] as AddPanelOptions).cwd).toBe("/worktrees/active");
  });

  it("leaves a reopened browser panel out of cwd resolution", async () => {
    const addPanel = vi.fn().mockResolvedValue(undefined);
    setPanelState({
      panels: [],
      addPanel,
      lastClosedConfig: { kind: "browser", cwd: "", browserUrl: "https://example.com" },
    });

    const run = setupActions();
    await run("terminal.duplicate");

    expect(resolveInheritedPanelCwdMock).not.toHaveBeenCalled();
  });

  it("browser panel duplication never carries a (copy)-suffixed title (service omits title)", async () => {
    const addPanel = vi.fn().mockResolvedValue(undefined);
    setPanelState({
      focusedId: "p1",
      panels: [{ id: "p1", location: "grid", kind: "browser", title: "Browser" }],
      addPanel,
    });
    const run = setupActions();
    await run("terminal.duplicate");

    const opts = addPanel.mock.calls[0]![0] as { title?: string };
    expect(opts.title).toBeUndefined();
  });

  // Regression: buildPanelDuplicateOptions normalizes the title back to the
  // agent default when a saved preset is stale (see panelDuplicationService.ts
  // presetWasStale branch). The duplicate action must respect that normalized
  // title and not re-append "(copy)" using the source panel's stale title.
  it("preserves stale-preset title normalization (no (copy) when service normalized title)", async () => {
    const addPanel = vi.fn().mockResolvedValue(undefined);
    buildPanelDuplicateOptionsMock.mockResolvedValueOnce({
      kind: "terminal",
      launchAgentId: "claude",
      title: "Claude", // normalized by service (stale preset dropped)
      location: "grid",
      cwd: "",
    });
    setPanelState({
      focusedId: "p1",
      panels: [
        {
          id: "p1",
          location: "grid",
          kind: "terminal",
          launchAgentId: "claude",
          detectedAgentId: "claude",
          title: "Claude (Deleted Preset)",
        },
      ],
      addPanel,
    });
    const run = setupActions();
    await run("terminal.duplicate");

    expect(addPanel.mock.calls[0]![0].title).toBe("Claude");
  });

  it("appends (copy) when a browser panel has a user-renamed title", async () => {
    const addPanel = vi.fn().mockResolvedValue(undefined);
    buildPanelDuplicateOptionsMock.mockResolvedValueOnce({
      kind: "browser",
      location: "grid",
      cwd: "",
      title: "My App",
    });
    setPanelState({
      focusedId: "p1",
      panels: [{ id: "p1", location: "grid", kind: "browser", title: "My App" }],
      addPanel,
    });
    const run = setupActions();
    await run("terminal.duplicate");

    expect(addPanel.mock.calls[0]![0].title).toBe("My App (copy)");
  });
});

describe("terminal.reopenLast journal fallback", () => {
  const resumeOptions = {
    kind: "terminal" as const,
    launchAgentId: "claude",
    title: "Claude",
    cwd: "/cwd",
    worktreeId: "wt-1",
    command: "claude --resume s-1",
    location: "grid" as const,
    agentSessionId: "s-1",
  };
  const session = {
    sessionId: "s-1",
    agentId: "claude",
    worktreeId: "wt-1",
    title: "Claude",
    projectId: null,
    savedAt: 1000,
  };

  it("flushes optimistic closes then restores from trash without touching the journal", async () => {
    const addPanel = vi.fn().mockResolvedValue(undefined);
    const restoreLastTrashed = vi.fn().mockReturnValue(true);
    setPanelState({ panels: [], addPanel, restoreLastTrashed });
    const run = setupActions();

    await run("terminal.reopenLast");

    expect(flushOptimisticClosesMock).toHaveBeenCalledTimes(1);
    expect(restoreLastTrashed).toHaveBeenCalledTimes(1);
    expect(listAgentSessionsMock).not.toHaveBeenCalled();
    expect(buildResumePanelOptionsMock).not.toHaveBeenCalled();
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("resumes the most recent journaled session (scoped to active worktree) when trash is empty", async () => {
    const addPanel = vi.fn().mockResolvedValue(undefined);
    setPanelState({
      panels: [],
      addPanel,
      restoreLastTrashed: vi.fn().mockReturnValue(false),
    });
    // Newest-first: only the first record should be resumed.
    listAgentSessionsMock.mockResolvedValue([session, { ...session, sessionId: "s-old" }]);
    buildResumePanelOptionsMock.mockReturnValue(resumeOptions);
    const run = setupActions();

    await run("terminal.reopenLast");

    expect(listAgentSessionsMock).toHaveBeenCalledWith("wt-1");
    expect(buildResumePanelOptionsMock).toHaveBeenCalledWith(session, {
      cwd: "/cwd",
      worktreeId: "wt-1",
    });
    expect(addPanel).toHaveBeenCalledWith(resumeOptions);
  });

  it("no-ops when there is no active worktree (never picks a global record)", async () => {
    const addPanel = vi.fn().mockResolvedValue(undefined);
    setPanelState({
      panels: [],
      addPanel,
      restoreLastTrashed: vi.fn().mockReturnValue(false),
    });
    const run = setupActions({ activeWorktreeId: undefined });

    await run("terminal.reopenLast");

    expect(listAgentSessionsMock).not.toHaveBeenCalled();
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("no-ops when the journal is empty", async () => {
    const addPanel = vi.fn().mockResolvedValue(undefined);
    setPanelState({
      panels: [],
      addPanel,
      restoreLastTrashed: vi.fn().mockReturnValue(false),
    });
    listAgentSessionsMock.mockResolvedValue([]);
    const run = setupActions();

    await run("terminal.reopenLast");

    expect(buildResumePanelOptionsMock).not.toHaveBeenCalled();
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("swallows a journal list rejection without spawning", async () => {
    const addPanel = vi.fn().mockResolvedValue(undefined);
    setPanelState({
      panels: [],
      addPanel,
      restoreLastTrashed: vi.fn().mockReturnValue(false),
    });
    listAgentSessionsMock.mockRejectedValue(new Error("ipc down"));
    const run = setupActions();

    await expect(run("terminal.reopenLast")).resolves.toBeUndefined();
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("no-ops when the record can't build resume options", async () => {
    const addPanel = vi.fn().mockResolvedValue(undefined);
    setPanelState({
      panels: [],
      addPanel,
      restoreLastTrashed: vi.fn().mockReturnValue(false),
    });
    listAgentSessionsMock.mockResolvedValue([session]);
    buildResumePanelOptionsMock.mockReturnValue(null);
    const run = setupActions();

    await run("terminal.reopenLast");

    expect(addPanel).not.toHaveBeenCalled();
  });

  it("focuses an already-open panel with the same session in the active worktree instead of spawning a duplicate", async () => {
    const addPanel = vi.fn().mockResolvedValue(undefined);
    const activateTerminal = vi.fn();
    setPanelState({
      panels: [
        {
          id: "p-live",
          location: "grid",
          kind: "terminal",
          agentSessionId: "s-1",
          worktreeId: "wt-1",
        },
      ],
      addPanel,
      activateTerminal,
      restoreLastTrashed: vi.fn().mockReturnValue(false),
    });
    listAgentSessionsMock.mockResolvedValue([session]);
    buildResumePanelOptionsMock.mockReturnValue(resumeOptions);
    const run = setupActions();

    await run("terminal.reopenLast");

    expect(activateTerminal).toHaveBeenCalledWith("p-live");
    expect(addPanel).not.toHaveBeenCalled();
  });

  it("does not steal focus across worktrees: a same-session panel in another worktree is ignored and a fresh resume spawns", async () => {
    const addPanel = vi.fn().mockResolvedValue(undefined);
    const activateTerminal = vi.fn();
    setPanelState({
      panels: [
        {
          id: "p-elsewhere",
          location: "grid",
          kind: "terminal",
          agentSessionId: "s-1",
          worktreeId: "wt-2",
        },
      ],
      addPanel,
      activateTerminal,
      restoreLastTrashed: vi.fn().mockReturnValue(false),
    });
    listAgentSessionsMock.mockResolvedValue([session]);
    buildResumePanelOptionsMock.mockReturnValue(resumeOptions);
    const run = setupActions();

    await run("terminal.reopenLast");

    expect(activateTerminal).not.toHaveBeenCalled();
    expect(addPanel).toHaveBeenCalledWith(resumeOptions);
  });

  it("blocks a second overlapping dispatch so the same session is not resumed twice", async () => {
    const addPanel = vi.fn().mockResolvedValue(undefined);
    setPanelState({
      panels: [],
      addPanel,
      restoreLastTrashed: vi.fn().mockReturnValue(false),
    });
    // Hold the journal lookup pending so both dispatches overlap in flight.
    let releaseList: (records: (typeof session)[]) => void = () => {};
    listAgentSessionsMock.mockReturnValue(
      new Promise((resolve) => {
        releaseList = resolve;
      })
    );
    buildResumePanelOptionsMock.mockReturnValue(resumeOptions);
    const run = setupActions();

    const first = run("terminal.reopenLast");
    const second = run("terminal.reopenLast");
    releaseList([session]);
    await Promise.all([first, second]);

    // First dispatch set the in-flight guard before awaiting; the second bailed.
    expect(listAgentSessionsMock).toHaveBeenCalledTimes(1);
    expect(addPanel).toHaveBeenCalledTimes(1);
  });

  it("ignores a trashed panel with the same session and spawns a fresh resume", async () => {
    const addPanel = vi.fn().mockResolvedValue(undefined);
    const activateTerminal = vi.fn();
    setPanelState({
      panels: [{ id: "p-trash", location: "trash", kind: "terminal", agentSessionId: "s-1" }],
      addPanel,
      activateTerminal,
      restoreLastTrashed: vi.fn().mockReturnValue(false),
    });
    listAgentSessionsMock.mockResolvedValue([session]);
    buildResumePanelOptionsMock.mockReturnValue(resumeOptions);
    const run = setupActions();

    await run("terminal.reopenLast");

    expect(activateTerminal).not.toHaveBeenCalled();
    expect(addPanel).toHaveBeenCalledWith(resumeOptions);
  });
});

describe("terminal.moveToNewWorktree", () => {
  it("delegates to the store's create-and-move method", async () => {
    const moveToNewWorktree = vi.fn();
    setPanelState({
      panels: [{ id: "p1", location: "grid", worktreeId: "wt-1" }],
      moveToNewWorktree,
    });
    const run = setupActions();

    await run("terminal.moveToNewWorktree", { terminalId: "p1" });

    expect(moveToNewWorktree).toHaveBeenCalledExactlyOnceWith("p1");
  });

  it("falls back to the focused panel when no terminal id is supplied", async () => {
    const moveToNewWorktree = vi.fn();
    setPanelState({
      focusedId: "p-focused",
      panels: [{ id: "p-focused", location: "grid", worktreeId: "wt-1" }],
      moveToNewWorktree,
    });
    const run = setupActions();

    await run("terminal.moveToNewWorktree", undefined);

    expect(moveToNewWorktree).toHaveBeenCalledExactlyOnceWith("p-focused");
  });

  it("does nothing when there is no panel to move", async () => {
    const moveToNewWorktree = vi.fn();
    setPanelState({ panels: [], moveToNewWorktree });
    const run = setupActions();

    await run("terminal.moveToNewWorktree", {});

    expect(moveToNewWorktree).not.toHaveBeenCalled();
  });

  // The gesture IS the interactive create-worktree dialog, so there is no
  // argument that makes this answerable headlessly — naming the terminal must
  // not help (#11877).
  it.each([undefined, {}, { terminalId: "p1" }])(
    "refuses agent dispatch (%j) instead of opening the dialog",
    async (args) => {
      const moveToNewWorktree = vi.fn();
      setPanelState({
        focusedId: "p1",
        panels: [{ id: "p1", location: "grid", worktreeId: "wt-1" }],
        moveToNewWorktree,
      });
      const run = setupActions();

      await expect(
        run("terminal.moveToNewWorktree", args, { dispatchSource: "agent" })
      ).rejects.toThrow(/opens the new-worktree dialog, which a headless caller can never answer/);

      expect(moveToNewWorktree).not.toHaveBeenCalled();
    }
  );
});

describe("terminal.moveToWorktree", () => {
  it("delegates the move to the rescue-aware helper", async () => {
    setPanelState({ panels: [{ id: "p1", location: "grid", worktreeId: "wt-1" }] });
    const run = setupActions();

    await run("terminal.moveToWorktree", { terminalId: "p1", worktreeId: "wt-2" });

    expect(moveTerminalToWorktreeAndFollowRescueMock).toHaveBeenCalledExactlyOnceWith("p1", "wt-2");
  });

  it("falls back to the focused panel when no terminal id is supplied", async () => {
    setPanelState({
      focusedId: "p-focused",
      panels: [{ id: "p-focused", location: "grid", worktreeId: "wt-1" }],
    });
    const run = setupActions();

    await run("terminal.moveToWorktree", { worktreeId: "wt-2" });

    expect(moveTerminalToWorktreeAndFollowRescueMock).toHaveBeenCalledExactlyOnceWith(
      "p-focused",
      "wt-2"
    );
  });

  it("captures the undo snapshot before moving so the undo restores the origin", async () => {
    setPanelState({ panels: [{ id: "p1", location: "grid", worktreeId: "wt-1" }] });
    const run = setupActions();

    await run("terminal.moveToWorktree", { terminalId: "p1", worktreeId: "wt-2" });

    expect(pushLayoutSnapshotMock).toHaveBeenCalledTimes(1);
    expect(moveTerminalToWorktreeAndFollowRescueMock).toHaveBeenCalledTimes(1);
    expect(pushLayoutSnapshotMock.mock.invocationCallOrder[0]).toBeLessThan(
      moveTerminalToWorktreeAndFollowRescueMock.mock.invocationCallOrder[0]!
    );
  });

  it("does nothing when the panel is already in the target worktree", async () => {
    setPanelState({ panels: [{ id: "p1", location: "grid", worktreeId: "wt-2" }] });
    const run = setupActions();

    await run("terminal.moveToWorktree", { terminalId: "p1", worktreeId: "wt-2" });

    expect(moveTerminalToWorktreeAndFollowRescueMock).not.toHaveBeenCalled();
    expect(pushLayoutSnapshotMock).not.toHaveBeenCalled();
  });

  it("does nothing when the panel does not exist", async () => {
    setPanelState({ panels: [] });
    const run = setupActions();

    await run("terminal.moveToWorktree", { terminalId: "ghost", worktreeId: "wt-2" });

    expect(moveTerminalToWorktreeAndFollowRescueMock).not.toHaveBeenCalled();
    expect(pushLayoutSnapshotMock).not.toHaveBeenCalled();
  });

  // Reachable from the assistant's action tier since #11877, so the focused
  // fallback above must not be reachable by an unbound agent call: focus drifts
  // across the MCP round trip, and this relocates a panel across worktrees
  // rather than merely rearranging it (#11532).
  it("rejects agent dispatch that names no terminal, without moving the focused panel", async () => {
    setPanelState({
      focusedId: "p-focused",
      panels: [{ id: "p-focused", location: "grid", worktreeId: "wt-1" }],
    });
    const run = setupActions();

    await expect(
      run("terminal.moveToWorktree", { worktreeId: "wt-2" }, { dispatchSource: "agent" })
    ).rejects.toThrow(
      /requires an explicit `terminalId` when dispatched by an agent or MCP client/
    );

    expect(moveTerminalToWorktreeAndFollowRescueMock).not.toHaveBeenCalled();
    // The snapshot is pushed just before the move, so an unpushed stack proves
    // the guard fired before any layout mutation, not merely before the helper.
    expect(pushLayoutSnapshotMock).not.toHaveBeenCalled();
  });

  it("still moves the terminal an agent names explicitly", async () => {
    setPanelState({
      focusedId: "p-focused",
      panels: [
        { id: "p-focused", location: "grid", worktreeId: "wt-1" },
        { id: "p-named", location: "grid", worktreeId: "wt-1" },
      ],
    });
    const run = setupActions();

    await run(
      "terminal.moveToWorktree",
      { terminalId: "p-named", worktreeId: "wt-2" },
      { dispatchSource: "agent" }
    );

    // The named panel, never the focused one — the whole point of the guard.
    expect(moveTerminalToWorktreeAndFollowRescueMock).toHaveBeenCalledExactlyOnceWith(
      "p-named",
      "wt-2"
    );
  });
});
