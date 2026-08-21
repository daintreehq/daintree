import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";

// Same collaborator-mocking shape as agentBookmarkActions.test.ts: the registry
// has to build in a node env, but only the resume action's own collaborators
// carry behavior here. `resumeSessionIntoPanel` is mocked so these tests cover
// what the ACTION decides — scope, lookup, target precedence, result shape —
// while agentResume.test.ts covers the focus-or-spawn half it delegates to.
const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn(() => ({})) }));
const currentViewStoreMock = vi.hoisted(() => ({ getCurrentViewStore: vi.fn() }));
const selectWorktreeMock = vi.hoisted(() => vi.fn());
const worktreeSelectionMock = vi.hoisted(() => ({
  useWorktreeSelectionStore: {
    getState: vi.fn(() => ({ activeWorktreeId: null, selectWorktree: selectWorktreeMock })),
  },
}));
const agentRegistryMock = vi.hoisted(() => ({
  AGENT_REGISTRY: { claude: { name: "Claude" } },
  getAgentDisplayTitle: vi.fn((id: string) => `Title:${id}`),
  getMergedPresetIdentities: vi.fn(() => []),
}));
const clientsMock = vi.hoisted(() => ({
  agentSettingsClient: { get: vi.fn() },
  cliAvailabilityClient: { get: vi.fn() },
  agentCapabilitiesClient: { getRegistry: vi.fn() },
  userAgentRegistryClient: { get: vi.fn() },
}));
const resumeMock = vi.hoisted(() => vi.fn());
const worktreeIndexMock = vi.hoisted(() => ({ getWorktreePathIndex: vi.fn() }));

vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
vi.mock("@/store/createWorktreeStore", () => currentViewStoreMock);
vi.mock("@/store/worktreeStore", () => worktreeSelectionMock);
vi.mock("@/store/agentSettingsStore", () => ({ useAgentSettingsStore: { getState: vi.fn() } }));
vi.mock("@/store/cliAvailabilityStore", () => ({ useCliAvailabilityStore: { getState: vi.fn() } }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { getState: vi.fn(() => ({})) } }));
vi.mock("@/store/projectStatsStore", () => ({ useProjectStatsStore: { getState: vi.fn() } }));
vi.mock("@/config/agents", () => agentRegistryMock);
vi.mock("@/store/storeAccessors", () => worktreeIndexMock);
vi.mock("@/services/agentResume", () => ({ resumeSessionIntoPanel: resumeMock }));
vi.mock("@/clients/userAgentRegistryClient", () => ({
  userAgentRegistryClient: clientsMock.userAgentRegistryClient,
}));
vi.mock("@/clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients")>();
  return {
    ...actual,
    agentSettingsClient: clientsMock.agentSettingsClient,
    cliAvailabilityClient: clientsMock.cliAvailabilityClient,
    agentCapabilitiesClient: clientsMock.agentCapabilitiesClient,
  };
});

import { registerAgentActions } from "../agentActions";

const RESUME_ID = "agentSessionHistory.resume";
const WT_A = "/repo/wt-a";
const WT_B = "/repo/wt-b";

const listMock = vi.fn();

function record(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    sessionId: "sess-1",
    agentId: "claude",
    worktreeId: WT_A,
    projectId: "proj-1",
    title: "Fix the parser",
    savedAt: 1_700_000_000_000,
    cwd: WT_A,
    ...overrides,
  } as AgentSessionRecord;
}

function definition(): AnyActionDefinition {
  const actions: ActionRegistry = new Map();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- resume doesn't touch callbacks; a bare stub builds the registry
  registerAgentActions(actions, {} as ActionCallbacks);
  const factory = actions.get(RESUME_ID);
  if (!factory) throw new Error(`missing ${RESUME_ID}`);
  return factory() as AnyActionDefinition;
}

function run(args?: unknown, ctx: Partial<ActionContext> = {}): Promise<unknown> {
  return definition().run(args, ctx as ActionContext);
}

/** Dispatch context for an MCP caller inside a project with two worktrees. */
const agentCtx: Partial<ActionContext> = {
  dispatchSource: "agent",
  projectId: "proj-1",
  activeWorktreeId: WT_A,
  activeWorktreePath: WT_A,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", { electron: { agentSessionHistory: { list: listMock } } });
  worktreeIndexMock.getWorktreePathIndex.mockReturnValue(
    new Map([
      [WT_A, WT_A],
      [WT_B, WT_B],
    ])
  );
  listMock.mockResolvedValue([record()]);
  resumeMock.mockResolvedValue({
    terminalId: "term-9",
    outcome: "created",
    worktreeId: WT_A,
  });
});

describe("agentSessionHistory.resume — schema", () => {
  it("rejects a blank session id rather than resuming an arbitrary session", () => {
    const parsed = definition().argsSchema?.safeParse({ worktreeId: WT_A, sessionId: "" });
    expect(parsed?.success).toBe(false);
  });

  it("accepts the worktree location aliases the shared vocabulary advertises", () => {
    const byId = definition().argsSchema?.safeParse({ worktreeId: WT_A, sessionId: "sess-1" });
    const byPath = definition().argsSchema?.safeParse({ worktreePath: WT_A, sessionId: "sess-1" });
    expect(byId?.success).toBe(true);
    expect(byPath?.success).toBe(true);
  });
});

describe("agentSessionHistory.resume — scope isolation", () => {
  it("refuses an agent dispatch that names no worktree", async () => {
    await expect(run({ sessionId: "sess-1" }, agentCtx)).rejects.toThrow(/explicit/i);
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it("refuses a session recorded in a different worktree instead of re-homing it", async () => {
    await expect(run({ worktreeId: WT_B, sessionId: "sess-1" }, agentCtx)).rejects.toThrow(
      /different directory/i
    );
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it("refuses a worktree id that is not open", async () => {
    await expect(run({ worktreeId: "/repo/gone", sessionId: "sess-1" }, agentCtx)).rejects.toThrow(
      /Unknown worktree/i
    );
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it("scopes the journal read by project, never unscoped", async () => {
    await run({ worktreeId: WT_A, sessionId: "sess-1" }, agentCtx);
    expect(listMock).toHaveBeenCalledWith(undefined, "proj-1");
  });

  it("falls back to a worktree-scoped read when no project is in context", async () => {
    await run({ worktreeId: WT_A, sessionId: "sess-1" }, { dispatchSource: "agent" });
    expect(listMock).toHaveBeenCalledWith(WT_A, undefined);
    // The pair (undefined, undefined) would list every project's history.
    expect(listMock).not.toHaveBeenCalledWith(undefined, undefined);
  });

  it("reports a missing id as not-found rather than resuming a near match", async () => {
    listMock.mockResolvedValue([record({ sessionId: "sess-other" })]);
    await expect(run({ worktreeId: WT_A, sessionId: "sess-1" }, agentCtx)).rejects.toThrow(
      /No resumable session with that id/i
    );
  });
});

describe("agentSessionHistory.resume — launch directory containment", () => {
  it("refuses a record whose recorded directory sits outside the asserted worktree", async () => {
    // The id check alone cannot catch this: with no worktree recorded and a cwd
    // matching nothing, the target inherits the asserted id and would launch in
    // /tmp/elsewhere while reporting the caller's worktree.
    listMock.mockResolvedValue([record({ worktreeId: null, cwd: "/tmp/elsewhere" })]);
    await expect(run({ worktreeId: WT_A, sessionId: "sess-1" }, agentCtx)).rejects.toThrow(
      /different directory/i
    );
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it("refuses a record whose recorded directory belongs to another open worktree", async () => {
    listMock.mockResolvedValue([record({ worktreeId: null, cwd: `${WT_B}/src` })]);
    await expect(run({ worktreeId: WT_A, sessionId: "sess-1" }, agentCtx)).rejects.toThrow(
      /different directory/i
    );
  });

  it("launches a record with no recorded directory in the asserted worktree", async () => {
    listMock.mockResolvedValue([record({ worktreeId: null, cwd: undefined })]);
    await run({ worktreeId: WT_A, sessionId: "sess-1" }, agentCtx);
    expect(resumeMock.mock.calls[0]?.[1]).toEqual({ cwd: WT_A, worktreeId: WT_A });
  });

  it("refuses a recorded directory that walks back out of the worktree", async () => {
    // Lexical prefix matching classifies this as inside WT_A, so the containment
    // check has to reject the traversal itself.
    listMock.mockResolvedValue([record({ worktreeId: null, cwd: `${WT_A}/../outside` })]);
    await expect(run({ worktreeId: WT_A, sessionId: "sess-1" }, agentCtx)).rejects.toThrow(
      /walks outside/i
    );
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it("treats an empty recorded directory as absent rather than a launch path", async () => {
    // `resolveResumeLaunchTarget` uses `??`, so "" is "present" and would reach
    // the spawn, where main quietly falls back to the project root or home.
    listMock.mockResolvedValue([record({ cwd: "   " })]);
    await run({ worktreeId: WT_A, sessionId: "sess-1" }, agentCtx);
    expect(resumeMock.mock.calls[0]?.[1]?.cwd).toBe(WT_A);
  });

  it("fails closed when the worktree index is unavailable", async () => {
    // Degrading here would mean launching a process into a directory nothing
    // verified is open.
    worktreeIndexMock.getWorktreePathIndex.mockReturnValue(null);
    await expect(run({ worktreeId: WT_A, sessionId: "sess-1" }, agentCtx)).rejects.toThrow(
      /worktree index/i
    );
    expect(resumeMock).not.toHaveBeenCalled();
  });
});

describe("agentSessionHistory.resume — launch target", () => {
  it("launches in the directory the record itself carries, not the caller's", async () => {
    listMock.mockResolvedValue([record({ cwd: `${WT_A}/nested` })]);
    await run({ worktreeId: WT_A, sessionId: "sess-1" }, agentCtx);
    expect(resumeMock.mock.calls[0]?.[1]).toMatchObject({
      cwd: `${WT_A}/nested`,
      worktreeId: WT_A,
    });
  });

  it("re-homes a record journaled without a worktree by its recorded cwd", async () => {
    listMock.mockResolvedValue([record({ worktreeId: null, cwd: WT_B })]);
    await run({ worktreeId: WT_B, sessionId: "sess-1" }, agentCtx);
    expect(resumeMock.mock.calls[0]?.[1]).toMatchObject({ worktreeId: WT_B, cwd: WT_B });
  });

  it("keeps a nested recorded directory rather than flattening it to the worktree root", async () => {
    // Resume is directory-coupled (#4781): the CLI looks for the conversation in
    // the exact directory it started in.
    listMock.mockResolvedValue([record({ cwd: `${WT_A}/packages/api` })]);
    await run({ worktreeId: WT_A, sessionId: "sess-1" }, agentCtx);
    expect(resumeMock.mock.calls[0]?.[1]?.cwd).toBe(`${WT_A}/packages/api`);
  });

  it("does not move the user's view on an agent dispatch", async () => {
    await run({ worktreeId: WT_A, sessionId: "sess-1" }, agentCtx);
    // The spawn hook is what would switch worktrees; agents pass none.
    expect(resumeMock.mock.calls[0]?.[2]?.onBeforeSpawn).toBeUndefined();
  });

  it("does not move the user's view on a plugin dispatch either", async () => {
    // A plugin is not a person asking — `!== "agent"` would have let it yank the
    // view, which is why this reads the shared foreground classifier instead.
    await run({ worktreeId: WT_A, sessionId: "sess-1" }, { ...agentCtx, dispatchSource: "plugin" });
    expect(resumeMock.mock.calls[0]?.[2]?.onBeforeSpawn).toBeUndefined();
  });

  it("lets a foreground dispatch switch to the session's worktree before spawning", async () => {
    await run({ worktreeId: WT_A, sessionId: "sess-1" }, { ...agentCtx, dispatchSource: "user" });
    const onBeforeSpawn = resumeMock.mock.calls[0]?.[2]?.onBeforeSpawn as (() => void) | undefined;
    expect(onBeforeSpawn).toBeTypeOf("function");
    onBeforeSpawn?.();
    expect(selectWorktreeMock).toHaveBeenCalledWith(WT_A, { source: "user" });
  });
});

describe("agentSessionHistory.resume — result", () => {
  it("returns the spawned terminal id and reports that it created a pane", async () => {
    const result = await run({ worktreeId: WT_A, sessionId: "sess-1" }, agentCtx);
    expect(result).toEqual({
      terminalId: "term-9",
      sessionId: "sess-1",
      worktreeId: WT_A,
      outcome: "created",
    });
  });

  it("reports a repeat resume as reusing the live pane, with the same terminal id", async () => {
    resumeMock.mockResolvedValue({
      terminalId: "term-9",
      outcome: "activatedExisting",
      worktreeId: WT_A,
    });
    const result = await run({ worktreeId: WT_A, sessionId: "sess-1" }, agentCtx);
    expect(result).toMatchObject({ terminalId: "term-9", outcome: "activatedExisting" });
  });

  it("declares a result shape that can carry structuredContent over MCP", () => {
    const def = definition();
    expect(def.mcpOutputSchema).toBe(true);
    // A nullable/optional/union top level silently emits no outputSchema at all,
    // so structuredContent would never populate (#11547).
    const json = def.resultSchema ? z.toJSONSchema(def.resultSchema, { io: "output" }) : undefined;
    expect(json?.["type"]).toBe("object");
  });

  it("validates what run() returns against the declared result schema", async () => {
    const def = definition();
    const result = await def.run(
      { worktreeId: WT_A, sessionId: "sess-1" },
      agentCtx as ActionContext
    );
    expect(def.resultSchema?.safeParse(result).success).toBe(true);
  });
});
