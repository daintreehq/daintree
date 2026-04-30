import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { AddPanelOptions } from "@/store/slices/panelRegistry/types";

const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const layoutUndoMock = vi.hoisted(() => ({
  getState: vi.fn(() => ({ pushLayoutSnapshot: vi.fn() })),
}));
const buildPanelDuplicateOptionsMock = vi.hoisted(() => vi.fn());

vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
vi.mock("@/store/layoutUndoStore", () => ({ useLayoutUndoStore: layoutUndoMock }));
vi.mock("@/services/terminal/panelDuplicationService", () => ({
  buildPanelDuplicateOptions: buildPanelDuplicateOptionsMock,
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

function setupActions() {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {
    getDefaultCwd: () => "/cwd",
    getActiveWorktreeId: () => "wt-1",
  } as unknown as ActionCallbacks;
  registerTerminalSpawnActions(actions, callbacks);
  return async (id: string, args?: unknown): Promise<unknown> => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    const def = factory() as AnyActionDefinition;
    return def.run(args, {} as never);
  };
}

type MockPanel = {
  id: string;
  location: "grid" | "dock" | "trash";
  kind?: "terminal" | "browser" | "notes" | "dev-preview";
  launchAgentId?: string;
  detectedAgentId?: string;
  title?: string;
};

function setPanelState(options: {
  focusedId?: string | null;
  panels?: MockPanel[];
  addPanel?: ReturnType<typeof vi.fn>;
  lastClosedConfig?: AddPanelOptions | null;
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
  });
}

beforeEach(() => {
  vi.clearAllMocks();
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
});

describe("terminal.duplicate (copy) suffix", () => {
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
