// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";

vi.mock("@/clients", () => ({
  terminalClient: {
    write: vi.fn(),
    submit: vi.fn().mockResolvedValue(undefined),
    batchDoubleEscape: vi.fn(),
  },
  projectClient: { getCurrent: vi.fn().mockResolvedValue(null) },
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("@/store/persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    save: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("@/hooks/useSendToAgentPalette", () => ({ openSendToAgentPalette: vi.fn() }));
vi.mock("@/lib/panelContextMenu", () => ({ openPanelContextMenu: vi.fn() }));
vi.mock("@/services/terminal/TerminalInstanceService", () => ({
  terminalInstanceService: { get: vi.fn(), notifyUserInput: vi.fn() },
}));
vi.mock("@/store/terminalInputStore", () => ({
  triggerPopStash: vi.fn(),
  triggerStashInput: vi.fn(),
}));

const { usePanelStore } = await import("@/store/panelStore");
const { terminalClient } = await import("@/clients");
const { registerTerminalInputActions } = await import("../terminalInputActions");
const { ActionService } = await import("@/services/ActionService");

type ActionRegistry = Parameters<typeof registerTerminalInputActions>[0];

function makeAgent(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    detectedAgentId: "claude",
    worktreeId: "wt-1",
    projectId: "proj-1",
    location: "grid",
    agentState: "working",
    hasPty: true,
    ...overrides,
  } as PtyPanelData;
}

function seedPanels(terminals: PtyPanelData[]): void {
  usePanelStore.setState({
    panelsById: Object.fromEntries(terminals.map((t) => [t.id, t])),
    panelIds: terminals.map((t) => t.id),
    focusedId: null,
  });
}

function buildRegistry(): ActionRegistry {
  const registry: ActionRegistry = new Map();
  registerTerminalInputActions(registry, {
    getActiveWorktreeId: () => "wt-1",
    onInject: vi.fn(),
  } as never);
  return registry;
}

function definition(id: string) {
  const factory = buildRegistry().get(id);
  if (!factory) throw new Error(`action ${id} not registered`);
  return factory();
}

async function run(id: string, args: unknown): Promise<unknown> {
  return definition(id).run(args as never, {} as never);
}

describe("terminal.interrupt (#12338)", () => {
  beforeEach(() => {
    usePanelStore.setState({ panelsById: {}, panelIds: [], focusedId: null });
    vi.clearAllMocks();
  });

  it("writes double-Escape to exactly the named terminal", async () => {
    seedPanels([makeAgent("a"), makeAgent("b")]);
    const result = await run("terminal.interrupt", { terminalId: "b" });
    expect(terminalClient.batchDoubleEscape).toHaveBeenCalledTimes(1);
    expect(terminalClient.batchDoubleEscape).toHaveBeenCalledWith(["b"]);
    expect(result).toMatchObject({
      terminalId: "b",
      agentId: "claude",
      agentStateAtDispatch: "working",
      method: "double-escape",
      status: "requested",
      support: "advertised",
    });
  });

  // The focused-panel fallback the neighbouring input actions have is exactly
  // what must not exist here: focus drifts across the MCP→IPC round trip, and a
  // mistargeted interrupt cancels a turn nobody asked to stop.
  it("never falls back to the focused terminal", async () => {
    seedPanels([makeAgent("a")]);
    usePanelStore.setState({ focusedId: "a" });
    await expect(run("terminal.interrupt", { terminalId: "ghost" })).rejects.toThrow(/ghost/);
    expect(terminalClient.batchDoubleEscape).not.toHaveBeenCalled();
  });

  it("reports an unverified agent as such, and still sends", async () => {
    seedPanels([makeAgent("a", { detectedAgentId: "aider" })]);
    const result = (await run("terminal.interrupt", { terminalId: "a" })) as {
      support: string;
      message: string;
      status: string;
    };
    expect(terminalClient.batchDoubleEscape).toHaveBeenCalledWith(["a"]);
    expect(result.support).toBe("unverified");
    expect(result.status).toBe("requested");
    expect(result.message).toContain("unverified");
  });

  it("refuses an agent that binds a different cancel key, writing nothing", async () => {
    seedPanels([makeAgent("a", { detectedAgentId: "goose" })]);
    await expect(run("terminal.interrupt", { terminalId: "a" })).rejects.toThrow(/Ctrl\+C/);
    expect(terminalClient.batchDoubleEscape).not.toHaveBeenCalled();
  });

  it("refuses an idle agent, writing nothing", async () => {
    seedPanels([makeAgent("a", { agentState: "idle" })]);
    await expect(run("terminal.interrupt", { terminalId: "a" })).rejects.toThrow(/not mid-turn/);
    expect(terminalClient.batchDoubleEscape).not.toHaveBeenCalled();
  });

  // `panelsById` is a plain object, so a prototype key resolves to a function
  // rather than undefined and would sail past a truthiness check.
  it("rejects a prototype-chain id instead of assessing Object.prototype", async () => {
    seedPanels([makeAgent("a")]);
    await expect(run("terminal.interrupt", { terminalId: "constructor" })).rejects.toThrow();
    expect(terminalClient.batchDoubleEscape).not.toHaveBeenCalled();
  });

  it("rejects an empty terminalId at the schema", () => {
    const parsed = definition("terminal.interrupt").argsSchema?.safeParse({ terminalId: "" });
    expect(parsed?.success).toBe(false);
  });

  it("never reports the agent as stopped", async () => {
    seedPanels([makeAgent("a")]);
    const result = (await run("terminal.interrupt", { terminalId: "a" })) as Record<
      string,
      unknown
    >;
    expect(result).not.toHaveProperty("interrupted");
    expect(result).not.toHaveProperty("stopped");
    expect(result.status).toBe("requested");
  });

  it("declines plugin dispatch, like the rest of the injection surface", () => {
    expect(definition("terminal.interrupt").denyPluginDispatch).toBe(true);
    expect(definition("terminal.interruptOwned").denyPluginDispatch).toBe(true);
  });
});

describe("terminal.interruptOwned (#12338)", () => {
  it("refuses renderer dispatch — ownership is checked in main", async () => {
    await expect(run("terminal.interruptOwned", { terminalId: "a" })).rejects.toThrow(
      /main-process path/
    );
  });

  it("shares the delegate's result schema so both advertise the same contract", () => {
    const owned = definition("terminal.interruptOwned");
    const delegate = definition("terminal.interrupt");
    expect(owned.resultSchema).toBe(delegate.resultSchema);
    expect(owned.mcpOutputSchema).toBe(true);
    expect(delegate.mcpOutputSchema).toBe(true);
  });

  // A nullable or non-object root silently disables `mcpOutputSchema`, and no
  // structuredContent is ever emitted (#11547).
  it("advertises an object-rooted output schema for both definitions", () => {
    const service = new ActionService();
    for (const [, factory] of buildRegistry()) service.register(factory());
    for (const id of ["terminal.interrupt", "terminal.interruptOwned"]) {
      const entry = service.list().find((e) => e.id === id);
      expect(entry?.outputSchema, id).toBeDefined();
      expect((entry?.outputSchema as { type?: string } | undefined)?.type, id).toBe("object");
    }
  });

  it("validates the delegate's payload against the advertised schema", async () => {
    usePanelStore.setState({ panelsById: {}, panelIds: [], focusedId: null });
    seedPanels([makeAgent("a")]);
    const service = new ActionService();
    for (const [, factory] of buildRegistry()) service.register(factory());
    const result = await service.dispatch("terminal.interrupt", { terminalId: "a" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });
});
