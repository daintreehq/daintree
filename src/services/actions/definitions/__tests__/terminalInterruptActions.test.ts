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
    saveTabGroups: vi.fn(),
    flush: vi.fn(),
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

/** Dispatch through the real service, so `resultSchema` validation actually runs. */
function service() {
  const svc = new ActionService();
  for (const [, factory] of buildRegistry()) svc.register(factory());
  return svc;
}

function statusSchema() {
  return (
    definition("terminal.interrupt").resultSchema as unknown as {
      shape: { status: { description?: string; options?: string[] } };
    }
  ).shape.status;
}

function describedStatus(): string {
  return statusSchema().description ?? "";
}

function statusValues(): string[] {
  return statusSchema().options ?? [];
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
    expect(result).toEqual({
      terminalId: "b",
      agentId: "claude",
      agentStateAtDispatch: "working",
      status: "requested",
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

  // The uncertainty rides on `status` itself, not a flag beside it a model can
  // validate and never branch on.
  it("reports an unverified agent in the status, and still sends", async () => {
    seedPanels([makeAgent("a", { detectedAgentId: "aider" })]);
    const result = (await run("terminal.interrupt", { terminalId: "a" })) as { status: string };
    expect(terminalClient.batchDoubleEscape).toHaveBeenCalledWith(["a"]);
    expect(result.status).toBe("requested-unverified");
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

  // `panelsById` is a plain object, so an inherited key resolves to a real value
  // and would sail past a truthiness check. The fixture is an interruptible
  // panel on the prototype: with `Object.hasOwn` removed this call succeeds and
  // writes, which is precisely the regression to catch — a bare "constructor"
  // would be refused later anyway and prove nothing.
  it("rejects an inherited id instead of interrupting a prototype panel", async () => {
    const inherited = Object.create({ "proto-panel": makeAgent("proto-panel") }) as Record<
      string,
      unknown
    >;
    inherited["a"] = makeAgent("a");
    usePanelStore.setState({
      panelsById: inherited as never,
      panelIds: ["a"],
      focusedId: null,
    });

    await expect(run("terminal.interrupt", { terminalId: "proto-panel" })).rejects.toThrow(
      /proto-panel/
    );
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
    expect(Object.keys(result).sort()).toEqual([
      "agentId",
      "agentStateAtDispatch",
      "status",
      "terminalId",
    ]);
  });

  // The contract lives in the value set, not the prose: every outcome this tool
  // can report is something it *asked for*, never something it observed. A
  // `status: "interrupted"` added later fails here. Asserted on the values
  // rather than the wording because a description can deny a claim ("neither
  // says the agent stopped") using the very words a regex would flag.
  it("can only report outcomes it requested, never ones it observed", () => {
    const values = statusValues();
    expect(values.length).toBeGreaterThan(1);
    for (const value of values) expect(value, value).toMatch(/^requested/);
  });

  // And the description has to hand the caller the follow-up, since the tool
  // itself can never supply it.
  it("points the caller at the terminal for the outcome it cannot report", () => {
    expect(describedStatus()).toMatch(/read the terminal/i);
  });

  it("declines plugin dispatch, like the rest of the injection surface", () => {
    expect(definition("terminal.interrupt").denyPluginDispatch).toBe(true);
    expect(definition("terminal.interruptOwned").denyPluginDispatch).toBe(true);
  });
});

describe("terminal.interruptOwned (#12338)", () => {
  beforeEach(() => {
    usePanelStore.setState({ panelsById: {}, panelIds: [], focusedId: null });
    vi.clearAllMocks();
  });

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

  // Every success path, not just the happy one: `resultSchema` is enforced by
  // the service, so a payload shaped for one branch and not the other fails
  // *after* the keystrokes have already gone out.
  it.each([
    ["claude", "working", undefined, "requested"],
    ["claude", "waiting", "question", "requested"],
    ["aider", "working", undefined, "requested-unverified"],
    ["aider", "waiting", "approval", "requested-unverified"],
  ] as const)(
    "dispatches %s observed %s and validates against the advertised schema",
    async (detectedAgentId, agentState, waitingReason, status) => {
      seedPanels([makeAgent("a", { detectedAgentId, agentState, waitingReason })]);

      const result = await service().dispatch("terminal.interrupt", { terminalId: "a" });

      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (result.ok) {
        expect(result.result).toEqual({
          terminalId: "a",
          agentId: detectedAgentId,
          agentStateAtDispatch: agentState,
          status,
        });
      }
    }
  );

  // A refusal a retry cannot change must not come back as EXECUTION_ERROR:
  // that code is in RETRIABLE_ERROR_CODES, and a model reading `retriable`
  // on a permanent refusal loops on it.
  it.each([
    ["goose target", { detectedAgentId: "goose" }],
    ["idle target", { agentState: "idle" as const }],
    ["exited target", { runtimeStatus: "exited" as const }],
  ])("reports a permanent refusal for a %s as non-retriable", async (_label, overrides) => {
    seedPanels([makeAgent("a", overrides as Partial<PtyPanelData>)]);

    const result = await service().dispatch("terminal.interrupt", { terminalId: "a" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(terminalClient.batchDoubleEscape).not.toHaveBeenCalled();
  });
});
