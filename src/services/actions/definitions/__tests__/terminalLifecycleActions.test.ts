import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { ActionId } from "@shared/types/actions";

const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const terminalInstanceServiceMock = vi.hoisted(() => ({
  focus: vi.fn(),
  cleanup: vi.fn(),
  applyRendererPolicy: vi.fn(),
  onPanelBackgrounded: vi.fn(),
  resetRenderer: vi.fn(),
}));
const terminalClientMock = vi.hoisted(() => ({
  killTerminal: vi.fn().mockResolvedValue(undefined),
  forceResume: vi.fn().mockResolvedValue(undefined),
  locate: vi.fn(),
}));
const viewWorkspaceIdMock = vi.hoisted(() => ({ getViewWorkspaceId: vi.fn() }));
const fireWatchNotificationMock = vi.hoisted(() => vi.fn());
const pendingDestructiveStoreMock = vi.hoisted(() => {
  let pending: unknown = null;
  return {
    state: {
      get pending() {
        return pending;
      },
      request: vi.fn((snap: TerminalPendingDestructiveActionSnapshot) => {
        pending = snap;
      }),
      clear: vi.fn(() => {
        pending = null;
      }),
    },
    reset: () => {
      pending = null;
    },
  };
});

vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
// ActionService is imported by the end-to-end plugin dispatch case; these are
// what it reaches at module load.
vi.mock("../../../../store/shortcutHintStore", () => ({
  shortcutHintStore: {
    getState: vi.fn(() => ({ counts: {}, show: vi.fn(), incrementCount: vi.fn() })),
  },
}));
vi.mock("../../../KeybindingService", () => ({
  keybindingService: { getEffectiveCombo: vi.fn(() => null), getDisplayCombo: vi.fn(() => "") },
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/services/terminal/TerminalInstanceService", () => {
  const terminalInstanceService = terminalInstanceServiceMock;
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});
vi.mock("@/clients", () => ({ terminalClient: terminalClientMock }));
vi.mock("@/store/viewWorkspaceId", () => viewWorkspaceIdMock);
vi.mock("@/lib/watchNotification", () => ({
  fireWatchNotification: fireWatchNotificationMock,
}));
vi.mock("@/store/terminalPendingDestructiveActionStore", () => ({
  useTerminalPendingDestructiveActionStore: { getState: () => pendingDestructiveStoreMock.state },
}));

// Run the optimistic-close commit synchronously so these tests assert the
// canonical trash outcome directly; the deferral is covered by
// optimisticPanelClose.test.ts, and the read-your-writes contract that depends
// on it by terminalLifecycleActions.optimisticClose.test.ts.
const optimisticPanelCloseMock = vi.hoisted(() => ({
  requestPanelClose: vi.fn((req: { commit: () => void }) => req.commit()),
  flushOptimisticCloses: vi.fn(),
}));
vi.mock("@/services/terminal/optimisticPanelClose", () => optimisticPanelCloseMock);

const launchFromRestoreRecoveryMock = vi.hoisted(() => vi.fn());
const isRestoreRecoveryLaunchingMock = vi.hoisted(() => vi.fn((_panelId: string) => false));
vi.mock("@/services/terminal/restoreRecoveryLaunch", () => ({
  launchFromRestoreRecovery: launchFromRestoreRecoveryMock,
  isRestoreRecoveryLaunching: isRestoreRecoveryLaunchingMock,
}));

import { registerTerminalLifecycleActions } from "../terminalLifecycleActions";
import type { TerminalPendingDestructiveActionSnapshot } from "@/store/terminalPendingDestructiveActionStore";
import { MAX_KILL_BATCH_TERMINALS } from "@shared/types/terminalKillBatch";
import { TerminalInOtherProjectError } from "@shared/utils/terminalInOtherProject";
import { UnactionableTargetError } from "@/services/actions/unactionableTarget";
import { load as loadTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";

// The service mock never evaluates the real module, so nothing registers it;
// loading caches the mock for the synchronous peek() call sites.
beforeAll(async () => {
  await loadTerminalService();
});

type MockPanel = {
  id: string;
  location: "grid" | "dock" | "trash" | "background";
  worktreeId?: string;
  excludeFromPersistence?: boolean;
};

function setPanelState(options: {
  focusedId?: string | null;
  panels?: MockPanel[];
  trashPanel?: ReturnType<typeof vi.fn>;
  postTrashFocusedId?: string | null;
}) {
  const panels = options.panels ?? [];
  const panelsById: Record<string, MockPanel> = {};
  for (const p of panels) panelsById[p.id] = p;
  let focusedId = options.focusedId ?? null;
  const trashPanel =
    options.trashPanel ??
    vi.fn((id: string) => {
      // Mirror the real `trashPanel`: the record survives, its location becomes
      // "trash". `closedIds` is derived from exactly that, so a mock leaving the
      // panel in the grid would make every close report it closed nothing.
      const panel = panelsById[id];
      if (panel) panel.location = "trash";
      if (options.postTrashFocusedId !== undefined) {
        focusedId = options.postTrashFocusedId;
      }
    });
  panelStoreMock.getState.mockImplementation(() => ({
    focusedId,
    panelIds: panels.map((p) => p.id),
    panelsById,
    trashPanel,
  }));
  return { trashPanel };
}

function registerActions(callbacks: Partial<ActionCallbacks> = {}): ActionRegistry {
  const actions: ActionRegistry = new Map();
  registerTerminalLifecycleActions(actions, callbacks as ActionCallbacks);
  return actions;
}

function setupActions(callbacks: Partial<ActionCallbacks> = {}) {
  const actions = registerActions(callbacks);
  return async (id: string, args?: unknown, ctx?: unknown): Promise<unknown> => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    const def = factory() as AnyActionDefinition;
    return def.run(args, (ctx ?? {}) as never);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pendingDestructiveStoreMock.reset();
  terminalClientMock.locate.mockResolvedValue({ found: false });
  viewWorkspaceIdMock.getViewWorkspaceId.mockReturnValue("proj-a");
});

// terminal.close routes through the optimistic-close coordinator (mocked here
// to run its commit synchronously). Focus handoff is the coordinator's job now
// and is covered by optimisticPanelClose.test.ts.
describe("terminal.close", () => {
  it("trashes the focused panel", async () => {
    const { trashPanel } = setPanelState({
      focusedId: "p1",
      panels: [
        { id: "p1", location: "grid" },
        { id: "p2", location: "grid" },
      ],
      postTrashFocusedId: "p2",
    });
    const run = setupActions();

    await run("terminal.close");

    expect(trashPanel).toHaveBeenCalledWith("p1");
  });

  it("trashes an explicit terminalId when provided", async () => {
    const { trashPanel } = setPanelState({
      focusedId: "p2",
      panels: [
        { id: "p1", location: "grid" },
        { id: "p2", location: "grid" },
      ],
      postTrashFocusedId: "p2",
    });
    const run = setupActions();

    await run("terminal.close", { terminalId: "p1" });

    expect(trashPanel).toHaveBeenCalledWith("p1");
  });

  it("no-ops when no targetable panel exists", async () => {
    const { trashPanel } = setPanelState({
      focusedId: null,
      panels: [{ id: "p1", location: "trash" }],
      postTrashFocusedId: null,
    });
    const run = setupActions();

    await run("terminal.close");

    expect(trashPanel).not.toHaveBeenCalled();
  });

  it("fallback skips background panels (#9937)", async () => {
    const { trashPanel } = setPanelState({
      focusedId: null,
      panels: [
        { id: "bg1", location: "background" },
        { id: "p2", location: "grid" },
      ],
      postTrashFocusedId: null,
    });
    const run = setupActions();

    await run("terminal.close");

    expect(trashPanel).toHaveBeenCalledWith("p2");
  });

  it("no-ops when only background panels remain (#9937)", async () => {
    const { trashPanel } = setPanelState({
      focusedId: null,
      panels: [{ id: "bg1", location: "background" }],
      postTrashFocusedId: null,
    });
    const run = setupActions();

    await run("terminal.close");

    expect(trashPanel).not.toHaveBeenCalled();
  });
});

// An MCP caller reads the roster straight after the ack, so the close has to be
// canonical before it resolves and a bad id has to fail rather than report "OK"
// (#11805). The store postcondition itself is covered end-to-end against the
// real coordinator in terminalLifecycleActions.optimisticClose.test.ts.
describe("terminal.close result contract (#11805)", () => {
  it("names the panel it closed", async () => {
    setPanelState({
      focusedId: "p1",
      panels: [
        { id: "p1", location: "grid" },
        { id: "p2", location: "grid" },
      ],
      postTrashFocusedId: "p2",
    });
    const run = setupActions();

    await expect(run("terminal.close", { terminalId: "p1" })).resolves.toEqual({
      closedIds: ["p1"],
    });
  });

  it("rejects a named panel that is not tracked instead of reporting success", async () => {
    const { trashPanel } = setPanelState({
      focusedId: "p1",
      panels: [{ id: "p1", location: "grid" }],
    });
    const run = setupActions();

    await expect(run("terminal.close", { terminalId: "ghost" })).rejects.toThrow(/ghost/);
    expect(trashPanel).not.toHaveBeenCalled();
    expect(optimisticPanelCloseMock.requestPanelClose).not.toHaveBeenCalled();
  });

  it("closes nothing when the named panel is already trashed", async () => {
    const { trashPanel } = setPanelState({
      focusedId: null,
      panels: [{ id: "p1", location: "trash" }],
    });
    const run = setupActions();

    // Re-trashing would reset the recovery TTL and rewrite the restore target.
    await expect(run("terminal.close", { terminalId: "p1" })).resolves.toEqual({ closedIds: [] });
    expect(trashPanel).not.toHaveBeenCalled();
  });

  it.each(["user", "keybinding", "menu", "context-menu"] as const)(
    "leaves the deferral intact for %s dispatch",
    async (dispatchSource) => {
      setPanelState({ focusedId: "p1", panels: [{ id: "p1", location: "grid" }] });
      const run = setupActions();

      // The paint-frame protection is the whole point of the optimistic path;
      // a person is watching this one land. The result still names the panel.
      await expect(
        run("terminal.close", { terminalId: "p1" }, { dispatchSource })
      ).resolves.toEqual({ closedIds: ["p1"] });

      expect(optimisticPanelCloseMock.requestPanelClose).toHaveBeenCalled();
      expect(optimisticPanelCloseMock.flushOptimisticCloses).not.toHaveBeenCalled();
    }
  );
});

describe("terminal.close on a terminal outside this view (#13120)", () => {
  const MISS = 'terminal.close: no panel with id "t1" — pass an `id` from the terminal listing.';

  async function closeError(): Promise<Error> {
    const outcome: unknown = await setupActions()("terminal.close", { terminalId: "t1" }).then(
      () => new Error("expected terminal.close to reject"),
      (err: unknown) => err
    );
    if (!(outcome instanceof Error)) throw new Error("terminal.close rejected with a non-Error");
    return outcome;
  }

  it.each([true, false])(
    "fails with TerminalInOtherProjectError when running in another project (viewResident %s)",
    async (viewResident) => {
      const { trashPanel } = setPanelState({ panels: [{ id: "p1", location: "grid" }] });
      terminalClientMock.locate.mockResolvedValue({
        found: true,
        projectId: "proj-b",
        viewResident,
      });

      const err = await closeError();

      if (!(err instanceof TerminalInOtherProjectError)) throw err;
      expect(err.toDetails()).toEqual({
        actionId: "terminal.close",
        terminalId: "t1",
        projectId: "proj-b",
        viewResident,
      });
      expect(terminalClientMock.locate).toHaveBeenCalledWith("t1");
      expect(trashPanel).not.toHaveBeenCalled();
      expect(optimisticPanelCloseMock.requestPanelClose).not.toHaveBeenCalled();
      expect(optimisticPanelCloseMock.flushOptimisticCloses).not.toHaveBeenCalled();
    }
  );

  it("keeps the ordinary miss when nothing live is found", async () => {
    setPanelState({ panels: [] });

    const err = await closeError();

    expect(err).not.toBeInstanceOf(TerminalInOtherProjectError);
    expect(err.message).toBe(MISS);
  });

  it("keeps the ordinary miss when the terminal belongs to this workspace", async () => {
    setPanelState({ panels: [] });
    terminalClientMock.locate.mockResolvedValue({
      found: true,
      projectId: "proj-a",
      viewResident: true,
    });

    const err = await closeError();

    expect(err).not.toBeInstanceOf(TerminalInOtherProjectError);
    expect(err.message).toBe(MISS);
  });

  it("keeps the ordinary miss, without a lookup, when this view's workspace is unknown", async () => {
    setPanelState({ panels: [] });
    viewWorkspaceIdMock.getViewWorkspaceId.mockReturnValue(null);
    terminalClientMock.locate.mockResolvedValue({
      found: true,
      projectId: "proj-b",
      viewResident: true,
    });

    const err = await closeError();

    expect(err.message).toBe(MISS);
    expect(terminalClientMock.locate).not.toHaveBeenCalled();
  });

  it("keeps the ordinary miss when the lookup itself fails", async () => {
    setPanelState({ panels: [] });
    terminalClientMock.locate.mockRejectedValue(new Error("ipc down"));

    const err = await closeError();

    expect(err.message).toBe(MISS);
  });

  it("never looks up a panel this view holds", async () => {
    setPanelState({ focusedId: "p1", panels: [{ id: "p1", location: "grid" }] });

    await expect(setupActions()("terminal.close", { terminalId: "p1" })).resolves.toEqual({
      closedIds: ["p1"],
    });
    expect(terminalClientMock.locate).not.toHaveBeenCalled();
  });

  it("treats a prototype key as a miss, not a panel", async () => {
    const { trashPanel } = setPanelState({ panels: [] });

    await expect(setupActions()("terminal.close", { terminalId: "constructor" })).rejects.toThrow(
      /no panel with id "constructor"/
    );
    expect(trashPanel).not.toHaveBeenCalled();
  });
});

describe("terminal.closeAll result contract (#11805)", () => {
  const inWorktree = (id: string) => setupActions({ getActiveWorktreeId: () => id });

  it("names every panel it closed in the active worktree", async () => {
    setPanelState({
      panels: [
        { id: "a", location: "grid", worktreeId: "wt1" },
        { id: "b", location: "grid", worktreeId: "wt1" },
        { id: "elsewhere", location: "grid", worktreeId: "wt2" },
        { id: "gone", location: "trash", worktreeId: "wt1" },
        { id: "internal", location: "grid", worktreeId: "wt1", excludeFromPersistence: true },
      ],
    });
    const run = inWorktree("wt1");

    await expect(run("terminal.closeAll", undefined, { dispatchSource: "agent" })).resolves.toEqual(
      { closedIds: ["a", "b"] }
    );
  });

  it("closes nothing when the active worktree has no eligible panels", async () => {
    setPanelState({ panels: [{ id: "elsewhere", location: "grid", worktreeId: "wt2" }] });
    const run = inWorktree("wt1");

    await expect(run("terminal.closeAll", undefined, { dispatchSource: "agent" })).resolves.toEqual(
      { closedIds: [] }
    );
    expect(optimisticPanelCloseMock.requestPanelClose).not.toHaveBeenCalled();
  });

  it("settles before resolving for agent dispatch but not for a keybinding", async () => {
    setPanelState({ panels: [{ id: "a", location: "grid", worktreeId: "wt1" }] });

    await inWorktree("wt1")("terminal.closeAll", undefined, { dispatchSource: "agent" });
    expect(optimisticPanelCloseMock.flushOptimisticCloses).toHaveBeenCalled();

    optimisticPanelCloseMock.flushOptimisticCloses.mockClear();
    setPanelState({ panels: [{ id: "b", location: "grid", worktreeId: "wt1" }] });

    // Foreground keeps the deferral but still names what it accepted, so a
    // keybinding caller is not told the close was a no-op.
    await expect(
      inWorktree("wt1")("terminal.closeAll", undefined, { dispatchSource: "keybinding" })
    ).resolves.toEqual({ closedIds: ["b"] });
    expect(optimisticPanelCloseMock.flushOptimisticCloses).not.toHaveBeenCalled();
  });
});

type AgentPanel = {
  id: string;
  kind?: string;
  location: "grid" | "dock" | "trash" | "background";
  excludeFromPersistence?: boolean;
  removeOnExit?: boolean;
  detectedAgentId?: string;
  launchAgentId?: string;
  agentState?: string;
  worktreeId?: string;
  agentPresetId?: string;
  restoreRecovery?: { reason: string; sessionId?: string; awaitingDestination?: true };
};

function setRichPanelState(options: { focusedId?: string | null; panels: AgentPanel[] }) {
  const panels = options.panels;
  const panelsById: Record<string, AgentPanel> = {};
  for (const p of panels) panelsById[p.id] = p;
  const removePanel = vi.fn();
  const restartTerminal = vi.fn();
  const restartTerminalOnPreset = vi.fn().mockResolvedValue({ success: true });
  const bulkRestartAll = vi.fn().mockResolvedValue(undefined);
  const bulkRestartByWorktree = vi.fn().mockResolvedValue(undefined);
  panelStoreMock.getState.mockImplementation(() => ({
    focusedId: options.focusedId ?? null,
    panelIds: panels.map((p) => p.id),
    panelsById,
    removePanel,
    restartTerminal,
    restartTerminalOnPreset,
    bulkRestartAll,
    bulkRestartByWorktree,
  }));
  return { removePanel, restartTerminal, restartTerminalOnPreset, bulkRestartAll };
}

describe("terminal.kill confirm gate", () => {
  it("kills immediately when the terminal is a bare PTY (no agent)", async () => {
    const { removePanel } = setRichPanelState({
      focusedId: "p1",
      panels: [{ id: "p1", location: "grid" }],
    });
    const run = setupActions();

    await run("terminal.kill", { terminalId: "p1" });

    expect(removePanel).toHaveBeenCalledWith("p1");
    expect(pendingDestructiveStoreMock.state.request).not.toHaveBeenCalled();
  });

  it("kills immediately when the agent is idle (not in CLOSE_CONFIRM state)", async () => {
    const { removePanel } = setRichPanelState({
      focusedId: "p1",
      panels: [
        {
          id: "p1",
          location: "grid",
          detectedAgentId: "claude",
          agentState: "idle",
        },
      ],
    });
    const run = setupActions();

    await run("terminal.kill", { terminalId: "p1" });

    expect(removePanel).toHaveBeenCalledWith("p1");
    expect(pendingDestructiveStoreMock.state.request).not.toHaveBeenCalled();
  });

  it("does not kill when an agent is mid-work without confirmed:true — requests confirmation and fails", async () => {
    const { removePanel } = setRichPanelState({
      focusedId: "p1",
      panels: [
        {
          id: "p1",
          location: "grid",
          detectedAgentId: "claude",
          agentState: "working",
        },
      ],
    });
    const run = setupActions();

    await expect(run("terminal.kill", { terminalId: "p1" })).rejects.toThrow(/needs confirmation/);

    expect(removePanel).not.toHaveBeenCalled();
    expect(pendingDestructiveStoreMock.state.request).toHaveBeenCalledWith({
      kind: "kill",
      targetCount: 1,
      runningAgentCount: 1,
      terminalId: "p1",
    });
  });

  it("kills when an agent is mid-work and confirmed:true is passed", async () => {
    const { removePanel } = setRichPanelState({
      focusedId: "p1",
      panels: [
        {
          id: "p1",
          location: "grid",
          detectedAgentId: "claude",
          agentState: "working",
        },
      ],
    });
    const run = setupActions();

    await run("terminal.kill", { terminalId: "p1", confirmed: true });

    expect(removePanel).toHaveBeenCalledWith("p1");
    expect(pendingDestructiveStoreMock.state.request).not.toHaveBeenCalled();
  });
});

describe("terminal.killBatch", () => {
  function killBatchArgsSchema() {
    const actions: ActionRegistry = new Map();
    registerTerminalLifecycleActions(actions, {} as ActionCallbacks);
    const def = actions.get("terminal.killBatch")?.() as AnyActionDefinition;
    return def.argsSchema;
  }

  // The action and the MCP bridge share one schema (shared/types/terminalKillBatch),
  // so the bridge never renders a checklist the dispatch would then refuse. These
  // assert the action's own end of that contract still carries every constraint —
  // `.describe()` returning a schema that had dropped the refinements would let
  // duplicate ids through, and duplicates are two rows with one checkbox identity.
  it("rejects a repeated id", () => {
    expect(killBatchArgsSchema()?.safeParse({ terminalIds: ["p1", "p1"] }).success).toBe(false);
  });

  it("rejects more ids than a human can be asked to read", () => {
    const overCap = Array.from({ length: MAX_KILL_BATCH_TERMINALS + 1 }, (_, i) => `t${i}`);
    expect(killBatchArgsSchema()?.safeParse({ terminalIds: overCap }).success).toBe(false);
    const atCap = overCap.slice(0, MAX_KILL_BATCH_TERMINALS);
    expect(killBatchArgsSchema()?.safeParse({ terminalIds: atCap }).success).toBe(true);
  });

  it("rejects an empty list rather than treating it as a no-op batch", () => {
    expect(killBatchArgsSchema()?.safeParse({ terminalIds: [] }).success).toBe(false);
  });

  function approve(ids: string[], observed: Record<string, boolean> = {}) {
    return {
      hostConfirmed: true,
      hostApprovedTargets: ids.map((id) => ({
        id,
        observedAgentRunning: observed[id] ?? false,
      })),
    };
  }

  it("refuses without a per-target attestation, even when the host confirmed", async () => {
    const { removePanel } = setRichPanelState({
      panels: [{ id: "p1", location: "grid" }],
    });
    const run = setupActions();

    await expect(
      run("terminal.killBatch", { terminalIds: ["p1"] }, { hostConfirmed: true })
    ).rejects.toThrow(/per-target approval/);

    expect(removePanel).not.toHaveBeenCalled();
  });

  it("kills every approved target and reports them in request order", async () => {
    const { removePanel } = setRichPanelState({
      panels: [
        { id: "p1", location: "grid" },
        { id: "p2", location: "grid" },
      ],
    });
    const run = setupActions();

    const result = await run(
      "terminal.killBatch",
      { terminalIds: ["p2", "p1"] },
      approve(["p1", "p2"])
    );

    expect(result).toEqual({
      killedIds: ["p2", "p1"],
      excludedIds: [],
      notFoundIds: [],
      skippedIds: [],
      failedIds: [],
    });
    expect(removePanel).toHaveBeenCalledWith("p1");
    expect(removePanel).toHaveBeenCalledWith("p2");
  });

  it("reports a deselected id as excluded and never touches it", async () => {
    const { removePanel } = setRichPanelState({
      panels: [
        { id: "p1", location: "grid" },
        { id: "p2", location: "grid" },
      ],
    });
    const run = setupActions();

    const result = await run("terminal.killBatch", { terminalIds: ["p1", "p2"] }, approve(["p1"]));

    expect(result).toEqual({
      killedIds: ["p1"],
      excludedIds: ["p2"],
      notFoundIds: [],
      skippedIds: [],
      failedIds: [],
    });
    expect(removePanel).not.toHaveBeenCalledWith("p2");
  });

  it("reports an id with no live panel as notFound rather than killed", async () => {
    const { removePanel } = setRichPanelState({
      panels: [{ id: "p1", location: "grid" }],
    });
    const run = setupActions();

    const result = await run(
      "terminal.killBatch",
      { terminalIds: ["p1", "gone"] },
      approve(["p1", "gone"])
    );

    expect(result).toEqual({
      killedIds: ["p1"],
      excludedIds: [],
      notFoundIds: ["gone"],
      skippedIds: [],
      failedIds: [],
    });
    expect(removePanel).toHaveBeenCalledTimes(1);
  });

  it("does not resolve an id off Object.prototype", async () => {
    const { removePanel } = setRichPanelState({ panels: [] });
    const run = setupActions();

    const result = await run(
      "terminal.killBatch",
      { terminalIds: ["constructor"] },
      approve(["constructor"])
    );

    expect(result).toEqual({
      killedIds: [],
      excludedIds: [],
      notFoundIds: ["constructor"],
      skippedIds: [],
      failedIds: [],
    });
    expect(removePanel).not.toHaveBeenCalled();
  });

  it("skips a target that started running an agent after the list froze", async () => {
    const { removePanel } = setRichPanelState({
      panels: [
        { id: "p1", location: "grid" },
        { id: "p2", location: "grid", detectedAgentId: "claude", agentState: "working" },
      ],
    });
    const run = setupActions();

    // The dialog showed both as idle; p2 is mid-work by the time this runs.
    const result = await run(
      "terminal.killBatch",
      { terminalIds: ["p1", "p2"] },
      approve(["p1", "p2"])
    );

    expect(result).toEqual({
      killedIds: ["p1"],
      excludedIds: [],
      notFoundIds: [],
      skippedIds: ["p2"],
      failedIds: [],
    });
    expect(removePanel).not.toHaveBeenCalledWith("p2");
  });

  it("still kills a target the approver saw running an agent", async () => {
    const { removePanel } = setRichPanelState({
      panels: [{ id: "p1", location: "grid", detectedAgentId: "claude", agentState: "working" }],
    });
    const run = setupActions();

    const result = await run(
      "terminal.killBatch",
      { terminalIds: ["p1"] },
      approve(["p1"], { p1: true })
    );

    expect(result).toEqual({
      killedIds: ["p1"],
      excludedIds: [],
      notFoundIds: [],
      skippedIds: [],
      failedIds: [],
    });
    expect(removePanel).toHaveBeenCalledWith("p1");
  });

  it("re-reads agent state per target rather than snapshotting once", async () => {
    const first: AgentPanel = { id: "p1", location: "grid" };
    const second: AgentPanel = { id: "p2", location: "grid" };
    const panels = [first, second];
    const panelsById: Record<string, AgentPanel> = { p1: first, p2: second };
    const removePanel = vi.fn((id: string) => {
      // Killing p1 is what sets p2 working — a snapshot taken before the loop
      // would never see it and would destroy p2 mid-work.
      if (id === "p1") {
        second.detectedAgentId = "claude";
        second.agentState = "working";
      }
    });
    panelStoreMock.getState.mockImplementation(() => ({
      focusedId: null,
      panelIds: panels.map((panel) => panel.id),
      panelsById,
      removePanel,
    }));
    const run = setupActions();

    const result = await run(
      "terminal.killBatch",
      { terminalIds: ["p1", "p2"] },
      approve(["p1", "p2"])
    );

    expect(result).toEqual({
      killedIds: ["p1"],
      excludedIds: [],
      notFoundIds: [],
      skippedIds: ["p2"],
      failedIds: [],
    });
  });

  it("ignores an attested id the call never requested", async () => {
    const { removePanel } = setRichPanelState({
      panels: [
        { id: "p1", location: "grid" },
        { id: "other", location: "grid" },
      ],
    });
    const run = setupActions();

    const result = await run(
      "terminal.killBatch",
      { terminalIds: ["p1"] },
      approve(["p1", "other"])
    );

    expect(result).toEqual({
      killedIds: ["p1"],
      excludedIds: [],
      notFoundIds: [],
      skippedIds: [],
      failedIds: [],
    });
    expect(removePanel).not.toHaveBeenCalledWith("other");
  });

  it("puts every requested id in exactly one bucket, in request order", async () => {
    const { removePanel } = setRichPanelState({
      panels: [
        { id: "keep", location: "grid" },
        { id: "refused", location: "grid" },
        { id: "busy", location: "grid", detectedAgentId: "claude", agentState: "working" },
      ],
    });
    const run = setupActions();

    const requested = ["keep", "refused", "vanished", "busy"];
    const result = (await run(
      "terminal.killBatch",
      { terminalIds: requested },
      approve(["keep", "vanished", "busy"])
    )) as Record<string, string[]>;

    expect(result).toEqual({
      killedIds: ["keep"],
      excludedIds: ["refused"],
      notFoundIds: ["vanished"],
      skippedIds: ["busy"],
      failedIds: [],
    });
    // Total and disjoint: the caller can account for every id it sent exactly
    // once, which is what makes the four outcomes actionable rather than a hint.
    const all = Object.values(result).flat();
    expect([...all].sort()).toEqual([...requested].sort());
    expect(new Set(all).size).toBe(requested.length);
    expect(removePanel).toHaveBeenCalledTimes(1);
    expect(removePanel).toHaveBeenCalledWith("keep");
  });

  it("keeps the rest of the batch and the record when one teardown throws", async () => {
    const { removePanel } = setRichPanelState({
      panels: [
        { id: "p1", location: "grid" },
        { id: "p2", location: "grid" },
        { id: "p3", location: "grid" },
      ],
    });
    removePanel.mockImplementation((id: string) => {
      if (id === "p2") throw new Error("teardown exploded");
    });
    const run = setupActions();

    const result = await run(
      "terminal.killBatch",
      { terminalIds: ["p1", "p2", "p3"] },
      approve(["p1", "p2", "p3"])
    );

    // p1's kill already happened and is irreversible — a thrown batch would
    // have reported only an execution error and invited a retry.
    expect(result).toEqual({
      killedIds: ["p1", "p3"],
      excludedIds: [],
      notFoundIds: [],
      skippedIds: [],
      failedIds: ["p2"],
    });
    expect(removePanel).toHaveBeenCalledWith("p3");
  });

  it("destroys nothing when the approver unchecked every row", async () => {
    const { removePanel } = setRichPanelState({
      panels: [{ id: "p1", location: "grid" }],
    });
    const run = setupActions();

    const result = await run("terminal.killBatch", { terminalIds: ["p1"] }, approve([]));

    expect(result).toEqual({
      killedIds: [],
      excludedIds: ["p1"],
      notFoundIds: [],
      skippedIds: [],
      failedIds: [],
    });
    expect(removePanel).not.toHaveBeenCalled();
  });
});

describe("terminal.restartOnPreset (#13746)", () => {
  it("refuses without confirmation even when the agent is idle", async () => {
    // A rate-limited agent is rarely working, and the conversation is lost
    // whatever its state, so the working-only gate of terminal.restart can't apply.
    const { restartTerminalOnPreset } = setRichPanelState({
      focusedId: "p1",
      panels: [{ id: "p1", location: "grid", detectedAgentId: "codex", agentState: "idle" }],
    });
    const run = setupActions();

    await expect(
      run("terminal.restartOnPreset", { terminalId: "p1", presetId: "work" })
    ).rejects.toThrow(/confirmed/);

    expect(restartTerminalOnPreset).not.toHaveBeenCalled();
  });

  it("restarts the pane on the preset once confirmed, and drops its rate-limit chip", async () => {
    const { useRateLimitObservationStore } = await import("@/store/rateLimitObservationStore");
    useRateLimitObservationStore.setState({ observedAtByTerminalId: { p1: Date.now() } });
    const { restartTerminalOnPreset } = setRichPanelState({
      focusedId: "p1",
      panels: [{ id: "p1", location: "grid", detectedAgentId: "codex", agentState: "waiting" }],
    });
    const run = setupActions();

    await run("terminal.restartOnPreset", { terminalId: "p1", presetId: "work", confirmed: true });

    expect(restartTerminalOnPreset).toHaveBeenCalledWith("p1", "work");
    expect(useRateLimitObservationStore.getState().observedAtByTerminalId.p1).toBeUndefined();
  });

  it("keeps an observation the new process made before the restart resolved", async () => {
    const { useRateLimitObservationStore } = await import("@/store/rateLimitObservationStore");
    useRateLimitObservationStore.setState({ observedAtByTerminalId: { p1: 1_000 } });
    const { restartTerminalOnPreset } = setRichPanelState({
      focusedId: "p1",
      panels: [{ id: "p1", location: "grid", detectedAgentId: "codex", agentState: "waiting" }],
    });
    restartTerminalOnPreset.mockImplementation(async () => {
      useRateLimitObservationStore.setState({ observedAtByTerminalId: { p1: 2_000 } });
      return { success: true };
    });
    const run = setupActions();

    await run("terminal.restartOnPreset", { terminalId: "p1", presetId: "work", confirmed: true });

    expect(useRateLimitObservationStore.getState().observedAtByTerminalId.p1).toBe(2_000);
  });

  // The MCP owned tool never forwards `confirmed` (#14369): the host's prompt
  // or grant is the approval, and the caller learns its brief is gone.
  it("restarts on a host-attested confirm and says the conversation was cleared", async () => {
    const pane: AgentPanel = {
      id: "p1",
      location: "grid",
      detectedAgentId: "codex",
      agentState: "waiting",
      agentPresetId: "personal",
    };
    const { restartTerminalOnPreset } = setRichPanelState({ focusedId: "p1", panels: [pane] });
    // The receipt reports what the store recorded, not the id the caller sent.
    restartTerminalOnPreset.mockImplementation(async () => {
      pane.agentPresetId = "work-resolved";
      return { success: true };
    });
    const run = setupActions();

    const result = await run(
      "terminal.restartOnPreset",
      { terminalId: "p1", presetId: "work" },
      { dispatchSource: "agent", hostConfirmed: true }
    );

    expect(restartTerminalOnPreset).toHaveBeenCalledWith("p1", "work");
    expect(result).toEqual({
      terminalId: "p1",
      agentPresetId: "work-resolved",
      agentSessionIdCleared: true,
    });
  });

  it("refuses the owned twin outside the MCP main-process path", async () => {
    const run = setupActions();

    await expect(
      run("terminal.restartOnPresetOwned", { terminalId: "p1", presetId: "work" })
    ).rejects.toThrow(/MCP main-process path/);
  });

  it("reports a respawn that failed instead of claiming success", async () => {
    const { restartTerminalOnPreset } = setRichPanelState({
      focusedId: "p1",
      panels: [{ id: "p1", location: "grid", detectedAgentId: "codex", agentState: "waiting" }],
    });
    restartTerminalOnPreset.mockResolvedValue({ success: false, error: 'preset "work" not found' });
    const run = setupActions();

    await expect(
      run("terminal.restartOnPreset", { terminalId: "p1", presetId: "work", confirmed: true })
    ).rejects.toThrow(/not found/);
  });
});

describe("terminal.restart confirm gate", () => {
  it("restarts immediately when the terminal is a bare PTY", async () => {
    const { restartTerminal } = setRichPanelState({
      focusedId: "p1",
      panels: [{ id: "p1", location: "grid" }],
    });
    const run = setupActions();

    await run("terminal.restart", { terminalId: "p1" });

    expect(restartTerminal).toHaveBeenCalledWith("p1");
    expect(pendingDestructiveStoreMock.state.request).not.toHaveBeenCalled();
  });

  it("requests confirmation when an agent is mid-work without confirmed:true", async () => {
    const { restartTerminal } = setRichPanelState({
      focusedId: "p1",
      panels: [
        {
          id: "p1",
          location: "grid",
          detectedAgentId: "claude",
          agentState: "working",
        },
      ],
    });
    const run = setupActions();

    await expect(run("terminal.restart", { terminalId: "p1" })).rejects.toThrow(
      /needs confirmation/
    );

    expect(restartTerminal).not.toHaveBeenCalled();
    expect(pendingDestructiveStoreMock.state.request).toHaveBeenCalledWith({
      kind: "restart",
      targetCount: 1,
      runningAgentCount: 1,
      terminalId: "p1",
    });
  });

  it("restarts when an agent is mid-work and confirmed:true is passed", async () => {
    const { restartTerminal } = setRichPanelState({
      focusedId: "p1",
      panels: [
        {
          id: "p1",
          location: "grid",
          detectedAgentId: "claude",
          agentState: "working",
        },
      ],
    });
    const run = setupActions();

    await run("terminal.restart", { terminalId: "p1", confirmed: true });

    expect(restartTerminal).toHaveBeenCalledWith("p1");
  });

  it("fails on a pane held for recovery, naming the hold, instead of reporting success", async () => {
    const { restartTerminal } = setRichPanelState({
      focusedId: "p1",
      panels: [
        {
          id: "p1",
          location: "grid",
          launchAgentId: "codex",
          restoreRecovery: { reason: "sibling-owns-resume-latest-slot" },
        },
      ],
    });
    const run = setupActions();

    const failure = run("terminal.restart", { terminalId: "p1", confirmed: true });

    await expect(failure).rejects.toBeInstanceOf(UnactionableTargetError);
    await expect(failure).rejects.toThrow(/sibling-owns-resume-latest-slot/);
    expect(restartTerminal).not.toHaveBeenCalled();
  });
});

describe("terminal.startHeld (#15270)", () => {
  beforeEach(() => {
    isRestoreRecoveryLaunchingMock.mockReturnValue(false);
  });

  // The target sits behind a focused decoy holding a different conversation,
  // so a lookup that read focus or the first pane would start the wrong one.
  function setHeldPane(panel: Partial<AgentPanel> = {}): AgentPanel {
    const target: AgentPanel = {
      id: "p1",
      location: "grid",
      launchAgentId: "codex",
      restoreRecovery: { reason: "host-ended-uncleanly", sessionId: "sess-1" },
      ...panel,
    };
    setRichPanelState({
      focusedId: "decoy",
      panels: [
        {
          id: "decoy",
          location: "grid",
          launchAgentId: "codex",
          restoreRecovery: { reason: "resume-deferred", sessionId: "sess-decoy" },
        },
        target,
      ],
    });
    return target;
  }

  function startHeldArgsSchema() {
    return (registerActions().get("terminal.startHeld")!() as AnyActionDefinition).argsSchema!;
  }

  it("resumes the named pane's recorded conversation, in place", async () => {
    setHeldPane();
    launchFromRestoreRecoveryMock.mockResolvedValue("launched");
    const run = setupActions();

    const result = await run("terminal.startHeld", { terminalId: "p1", start: "resume" });

    expect(launchFromRestoreRecoveryMock).toHaveBeenCalledTimes(1);
    expect(launchFromRestoreRecoveryMock).toHaveBeenCalledWith("p1", {
      kind: "resume",
      sessionId: "sess-1",
    });
    expect(result).toEqual({ terminalId: "p1", start: "resume", sessionId: "sess-1" });
  });

  it("starts a new conversation on fresh, even when the hold recorded one", async () => {
    setHeldPane();
    launchFromRestoreRecoveryMock.mockResolvedValue("launched");
    const run = setupActions();

    const result = await run("terminal.startHeld", { terminalId: "p1", start: "fresh" });

    expect(launchFromRestoreRecoveryMock).toHaveBeenCalledTimes(1);
    expect(launchFromRestoreRecoveryMock).toHaveBeenCalledWith("p1", { kind: "fresh" });
    expect(result).toEqual({ terminalId: "p1", start: "fresh" });
  });

  it("starts fresh a hold that recorded no conversation", async () => {
    setHeldPane({ restoreRecovery: { reason: "sibling-owns-resume-latest-slot" } });
    launchFromRestoreRecoveryMock.mockResolvedValue("launched");
    const run = setupActions();

    const result = await run("terminal.startHeld", { terminalId: "p1", start: "fresh" });

    expect(launchFromRestoreRecoveryMock).toHaveBeenCalledWith("p1", { kind: "fresh" });
    expect(result).toEqual({ terminalId: "p1", start: "fresh" });
  });

  it("starts a held pane in the dock", async () => {
    setHeldPane({ location: "dock" });
    launchFromRestoreRecoveryMock.mockResolvedValue("launched");
    const run = setupActions();

    await run("terminal.startHeld", { terminalId: "p1", start: "fresh" });

    expect(launchFromRestoreRecoveryMock).toHaveBeenCalledWith("p1", { kind: "fresh" });
  });

  it("refuses to resume a hold with no recorded conversation rather than starting fresh", async () => {
    setHeldPane({ restoreRecovery: { reason: "sibling-owns-resume-latest-slot" } });
    const run = setupActions();

    const failure = run("terminal.startHeld", { terminalId: "p1", start: "resume" });

    await expect(failure).rejects.toBeInstanceOf(UnactionableTargetError);
    await expect(failure).rejects.toThrow(/sibling-owns-resume-latest-slot/);
    expect(launchFromRestoreRecoveryMock).not.toHaveBeenCalled();
  });

  it("never resumes a conversation the caller names in place of the recorded one", async () => {
    setHeldPane();
    launchFromRestoreRecoveryMock.mockResolvedValue("launched");
    const run = setupActions();

    await run("terminal.startHeld", { terminalId: "p1", start: "resume", sessionId: "other" });

    expect(launchFromRestoreRecoveryMock).toHaveBeenCalledWith("p1", {
      kind: "resume",
      sessionId: "sess-1",
    });
  });

  it.each([
    ["no start", { terminalId: "p1" }],
    ["an unknown start", { terminalId: "p1", start: "latest" }],
    ["no terminal", { start: "fresh" }],
    ["an empty terminal id", { terminalId: "", start: "fresh" }],
  ])("rejects args with %s, and launches nothing on them", async (_label, args) => {
    setHeldPane();
    const run = setupActions();

    expect(startHeldArgsSchema().safeParse(args).success).toBe(false);
    await expect(run("terminal.startHeld", args)).rejects.toThrow();
    expect(launchFromRestoreRecoveryMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a pane that isn't held", { restoreRecovery: undefined }, /isn't held/],
    [
      "a pane waiting for a worktree",
      {
        restoreRecovery: { reason: "destination-unavailable", awaitingDestination: true as const },
      },
      /waiting for a worktree/,
    ],
    ["a held pane in the trash", { location: "trash" as const }, /in the trash/],
    ["a held pane in the background", { location: "background" as const }, /in the background/],
    ["a panel with no process", { kind: "browser" }, /No terminal 'p1'/],
  ])("refuses %s without launching", async (_label, panel, message) => {
    setHeldPane(panel);
    const run = setupActions();

    const failure = run("terminal.startHeld", { terminalId: "p1", start: "fresh" });

    await expect(failure).rejects.toBeInstanceOf(UnactionableTargetError);
    await expect(failure).rejects.toThrow(message);
    expect(launchFromRestoreRecoveryMock).not.toHaveBeenCalled();
  });

  it("refuses a pane that isn't in this view", async () => {
    setRichPanelState({ panels: [] });
    const run = setupActions();

    await expect(
      run("terminal.startHeld", { terminalId: "missing", start: "fresh" })
    ).rejects.toBeInstanceOf(UnactionableTargetError);
    expect(launchFromRestoreRecoveryMock).not.toHaveBeenCalled();
  });

  it("refuses a pane that is already starting, without a second launch", async () => {
    setHeldPane();
    isRestoreRecoveryLaunchingMock.mockImplementation((id: string) => id === "p1");
    const run = setupActions();

    const failure = run("terminal.startHeld", { terminalId: "p1", start: "resume" });

    await expect(failure).rejects.toBeInstanceOf(UnactionableTargetError);
    await expect(failure).rejects.toThrow(/already starting/);
    expect(launchFromRestoreRecoveryMock).not.toHaveBeenCalled();
  });

  it("names the trash, not a start in flight, for a pane trashed mid-start", async () => {
    setHeldPane({ location: "trash" });
    isRestoreRecoveryLaunchingMock.mockImplementation((id: string) => id === "p1");
    const run = setupActions();

    const failure = run("terminal.startHeld", { terminalId: "p1", start: "fresh" });

    await expect(failure).rejects.toThrow(/in the trash/);
    expect(launchFromRestoreRecoveryMock).not.toHaveBeenCalled();
  });

  it("fails without retry advice when another pane has the conversation", async () => {
    setHeldPane();
    launchFromRestoreRecoveryMock.mockResolvedValue("held-elsewhere");
    const run = setupActions();

    const failure = run("terminal.startHeld", { terminalId: "p1", start: "resume" });

    await expect(failure).rejects.toBeInstanceOf(UnactionableTargetError);
    await expect(failure).rejects.toThrow(/sess-1/);
  });

  it("says the pane left its hold, not that it failed, when it started elsewhere mid-call", async () => {
    const target = setHeldPane();
    launchFromRestoreRecoveryMock.mockImplementation(async () => {
      target.restoreRecovery = undefined;
      return "unavailable";
    });
    const run = setupActions();

    const failure = run("terminal.startHeld", { terminalId: "p1", start: "fresh" });

    await expect(failure).rejects.toBeInstanceOf(UnactionableTargetError);
    await expect(failure).rejects.toThrow(/isn't held/);
  });

  // A launch clears the hold when it commits, before it finishes, so mid-start
  // the pane reads as not held; it must not be sent to terminal.restart.
  it("says a pane mid-start is starting, not that it isn't held", async () => {
    setHeldPane({ restoreRecovery: undefined });
    isRestoreRecoveryLaunchingMock.mockImplementation((id: string) => id === "p1");
    const run = setupActions();

    const failure = run("terminal.startHeld", { terminalId: "p1", start: "fresh" });

    await expect(failure).rejects.toBeInstanceOf(UnactionableTargetError);
    await expect(failure).rejects.toThrow(/already starting/);
    await expect(failure).rejects.not.toThrow(/terminal\.restart/);
    expect(launchFromRestoreRecoveryMock).not.toHaveBeenCalled();
  });

  it("fails retriably when the pane is still held and its launch didn't go through", async () => {
    setHeldPane();
    launchFromRestoreRecoveryMock.mockResolvedValue("unavailable");
    const run = setupActions();

    const failure = run("terminal.startHeld", { terminalId: "p1", start: "fresh" });

    await expect(failure).rejects.toThrow(/still held/);
    await expect(failure).rejects.not.toBeInstanceOf(UnactionableTargetError);
  });
});

describe("terminal.killAll confirm gate", () => {
  it("kills all user-facing panels immediately when no agents are running", async () => {
    const { removePanel } = setRichPanelState({
      panels: [
        { id: "p1", location: "grid" },
        { id: "p2", location: "grid" },
        { id: "ephem", location: "dock", excludeFromPersistence: true },
      ],
    });
    const run = setupActions();

    await run("terminal.killAll");

    expect(removePanel).toHaveBeenCalledWith("p1");
    expect(removePanel).toHaveBeenCalledWith("p2");
    expect(removePanel).not.toHaveBeenCalledWith("ephem");
    expect(pendingDestructiveStoreMock.state.request).not.toHaveBeenCalled();
  });

  it("kills removeOnExit-only panels — only excludeFromPersistence is spared (flags independent)", async () => {
    const { removePanel } = setRichPanelState({
      panels: [
        { id: "p1", location: "grid" },
        { id: "rox", location: "grid", removeOnExit: true, excludeFromPersistence: false },
        { id: "ephem", location: "dock", excludeFromPersistence: true },
      ],
    });
    const run = setupActions();

    await run("terminal.killAll");

    expect(removePanel).toHaveBeenCalledWith("p1");
    expect(removePanel).toHaveBeenCalledWith("rox");
    expect(removePanel).not.toHaveBeenCalledWith("ephem");
  });

  it("requests confirmation when any user-facing panel has a running agent", async () => {
    const { removePanel } = setRichPanelState({
      panels: [
        { id: "p1", location: "grid" },
        {
          id: "p2",
          location: "grid",
          detectedAgentId: "claude",
          agentState: "working",
        },
      ],
    });
    const run = setupActions();

    await expect(run("terminal.killAll")).rejects.toThrow(/needs confirmation/);

    expect(removePanel).not.toHaveBeenCalled();
    expect(pendingDestructiveStoreMock.state.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "killAll",
        targetCount: 2,
        runningAgentCount: 1,
      })
    );
    // The preview must single out the same terminals the working count names.
    const [snapshot] = pendingDestructiveStoreMock.state.request.mock.calls.at(-1)!;
    const flagged = (snapshot.preview ?? [])
      .flatMap((group) => group.terminals)
      .filter((terminal) => terminal.hasRunningAgent);
    expect(flagged).toHaveLength(snapshot.runningAgentCount);
  });

  it("kills all when confirmed:true is passed even with running agents", async () => {
    const { removePanel } = setRichPanelState({
      panels: [
        { id: "p1", location: "grid" },
        {
          id: "p2",
          location: "grid",
          detectedAgentId: "claude",
          agentState: "working",
        },
      ],
    });
    const run = setupActions();

    await run("terminal.killAll", { confirmed: true });

    expect(removePanel).toHaveBeenCalledWith("p1");
    expect(removePanel).toHaveBeenCalledWith("p2");
  });
});

describe("terminal.restartAll confirm gate", () => {
  it("restarts immediately when no agents are running", async () => {
    const { bulkRestartAll } = setRichPanelState({
      panels: [{ id: "p1", location: "grid" }],
    });
    const run = setupActions();

    await run("terminal.restartAll");

    expect(bulkRestartAll).toHaveBeenCalledTimes(1);
    expect(pendingDestructiveStoreMock.state.request).not.toHaveBeenCalled();
  });

  it("requests confirmation when any non-trash panel has a running agent", async () => {
    const { bulkRestartAll } = setRichPanelState({
      panels: [
        { id: "p1", location: "grid" },
        {
          id: "p2",
          location: "grid",
          detectedAgentId: "claude",
          agentState: "working",
        },
        { id: "trashed", location: "trash" },
      ],
    });
    const run = setupActions();

    await expect(run("terminal.restartAll")).rejects.toThrow(/needs confirmation/);

    expect(bulkRestartAll).not.toHaveBeenCalled();
    expect(pendingDestructiveStoreMock.state.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "restartAll",
        targetCount: 2,
        runningAgentCount: 1,
      })
    );
  });

  it("restarts when confirmed:true is passed", async () => {
    const { bulkRestartAll } = setRichPanelState({
      panels: [
        {
          id: "p1",
          location: "grid",
          detectedAgentId: "claude",
          agentState: "working",
        },
      ],
    });
    const run = setupActions();

    await run("terminal.restartAll", { confirmed: true });

    expect(bulkRestartAll).toHaveBeenCalledTimes(1);
  });
});

describe("terminal.rename DOM handoff", () => {
  it("opens the inline rename input from a timer", async () => {
    vi.useFakeTimers();
    class TestCustomEvent<T = unknown> extends Event {
      readonly detail: T;

      constructor(type: string, eventInitDict?: CustomEventInit<T>) {
        super(type);
        this.detail = eventInitDict?.detail as T;
      }
    }
    const eventTarget = new EventTarget();
    const testWindow = {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      setTimeout: globalThis.setTimeout.bind(globalThis),
    } as unknown as Window;
    vi.stubGlobal("window", testWindow);
    vi.stubGlobal("CustomEvent", TestCustomEvent);

    const renameEvents: CustomEvent[] = [];
    const handleRename = (event: Event) => {
      renameEvents.push(event as CustomEvent);
    };
    window.addEventListener("daintree:rename-terminal", handleRename);

    try {
      setPanelState({
        focusedId: "p1",
        panels: [{ id: "p1", location: "grid" }],
      });
      const run = setupActions();

      await run("terminal.rename", { terminalId: "p1" });

      expect(renameEvents).toHaveLength(0);
      await vi.runOnlyPendingTimersAsync();
      expect(renameEvents).toHaveLength(1);
      expect(renameEvents[0]?.detail).toEqual({ id: "p1" });
    } finally {
      window.removeEventListener("daintree:rename-terminal", handleRename);
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

// Every action below resolves an omitted `terminalId` from ambient focus. That
// is right for a keybinding or a palette pick and wrong for a headless caller,
// which cannot see what is focused — so agent/MCP dispatch has to fail closed
// rather than act on whatever the user happens to be looking at (#11532).
describe("agent dispatch target binding (#11532)", () => {
  class TestCustomEvent<T = unknown> extends Event {
    readonly detail: T;

    constructor(type: string, eventInitDict?: CustomEventInit<T>) {
      super(type);
      this.detail = eventInitDict?.detail as T;
    }
  }

  const dispatchEvent = vi.fn();
  const getInfo = vi.fn().mockResolvedValue({ id: "explicit-panel" });

  // Matched in full rather than on /terminalId/ alone: several of these actions
  // destructure their args unguarded, so a bare `run(undefined)` raises a
  // TypeError that also mentions "terminalId" and would pass a loose assertion.
  const UNBOUND_TARGET =
    /requires an explicit `terminalId` when dispatched by an agent or MCP client/;

  // What ActionService actually hands run() for a target-less dispatch. It
  // rewrites undefined to {} only when the schema rejects undefined but accepts
  // {} (ActionService.ts), so a `.optional()` schema still receives undefined.
  // Each row below uses its own action's real shape, which also keeps the
  // undefined path — where an unguarded destructure would throw — under test.
  const OPTIONAL_SCHEMA = undefined;
  const OBJECT_SCHEMA = {};

  function setGuardState(
    options: { focusedId?: string | null; focusedPanel?: Record<string, unknown> } = {}
  ) {
    const focusedId = options.focusedId === undefined ? "focused-panel" : options.focusedId;
    const panelsById: Record<string, Record<string, unknown>> = {
      "focused-panel": {
        id: "focused-panel",
        location: "grid",
        ...(options.focusedPanel ?? {}),
      },
      "explicit-panel": { id: "explicit-panel", location: "grid" },
    };
    const store = {
      trashPanel: vi.fn(),
      removePanel: vi.fn(),
      restartTerminal: vi.fn(),
      // Commits like the real mover: terminal.background reads the landed
      // location back and fails a move that left the panel where it was.
      backgroundTerminal: vi.fn((id: string) => {
        const panel = panelsById[id];
        if (panel) panel.location = "background";
      }),
      backgroundPanelGroup: vi.fn(),
      getPanelGroup: vi.fn(() => undefined),
      updateTitle: vi.fn(),
      toggleInputLocked: vi.fn(),
      watchPanel: vi.fn(),
      unwatchPanel: vi.fn(),
    };
    panelStoreMock.getState.mockImplementation(() => ({
      focusedId,
      // "explicit-panel" leads deliberately: terminal.close falls past focus to
      // the first visible panel, so listing the focused one first would let its
      // interactive assertion pass even with the focusedId leg removed.
      panelIds: ["explicit-panel", "focused-panel"],
      panelsById,
      watchedPanels: new Set<string>(),
      ...store,
    }));
    return {
      ...store,
      resetRenderer: terminalInstanceServiceMock.resetRenderer,
      forceResume: terminalClientMock.forceResume,
      requestConfirm: pendingDestructiveStoreMock.state.request,
      dispatchEvent,
      getInfo,
    };
  }

  type GuardSpies = ReturnType<typeof setGuardState>;

  beforeEach(() => {
    dispatchEvent.mockClear();
    getInfo.mockClear();
    vi.stubGlobal("window", {
      dispatchEvent,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      electron: { terminal: { getInfo } },
    });
    vi.stubGlobal("CustomEvent", TestCustomEvent);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Asserts the CustomEvent the info dialogs fire carried the focused panel.
  function expectInfoEventFor(id: string) {
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const event = dispatchEvent.mock.calls[0]?.[0] as CustomEvent<{ id: string }>;
    expect(event.type).toBe("daintree:open-terminal-info");
    expect(event.detail).toEqual({ id });
  }

  const GUARDED: ReadonlyArray<{
    id: string;
    // The target-less args this action really receives (see above).
    noTarget: unknown;
    // Extra args the interactive case needs beyond a target.
    interactiveArgs?: Record<string, unknown>;
    // Must NOT have run when agent dispatch named no terminal.
    blocked: (spies: GuardSpies) => { mock: { calls: unknown[] } };
    // Must have acted on the focused terminal for interactive dispatch.
    hitFocused: (spies: GuardSpies) => void;
  }> = [
    {
      id: "terminal.close",
      noTarget: OPTIONAL_SCHEMA,
      blocked: (s) => s.trashPanel,
      hitFocused: (s) => expect(s.trashPanel).toHaveBeenCalledWith("focused-panel"),
    },
    {
      id: "terminal.trash",
      noTarget: OBJECT_SCHEMA,
      blocked: (s) => s.trashPanel,
      hitFocused: (s) => expect(s.trashPanel).toHaveBeenCalledWith("focused-panel"),
    },
    {
      id: "terminal.background",
      noTarget: OPTIONAL_SCHEMA,
      blocked: (s) => s.backgroundTerminal,
      hitFocused: (s) => expect(s.backgroundTerminal).toHaveBeenCalledWith("focused-panel"),
    },
    {
      id: "terminal.kill",
      noTarget: OBJECT_SCHEMA,
      blocked: (s) => s.removePanel,
      hitFocused: (s) => expect(s.removePanel).toHaveBeenCalledWith("focused-panel"),
    },
    {
      id: "terminal.restart",
      noTarget: OBJECT_SCHEMA,
      blocked: (s) => s.restartTerminal,
      hitFocused: (s) => expect(s.restartTerminal).toHaveBeenCalledWith("focused-panel"),
    },
    {
      id: "terminal.redraw",
      noTarget: OPTIONAL_SCHEMA,
      blocked: (s) => s.resetRenderer,
      // #11638: the explicit user path forces past the streaming-write
      // deferral. An unforced call here would be the bug this action shipped.
      hitFocused: (s) =>
        expect(s.resetRenderer).toHaveBeenCalledWith("focused-panel", { force: true }),
    },
    {
      id: "terminal.rename",
      noTarget: OBJECT_SCHEMA,
      // Carries a name so the interactive case takes the programmatic path.
      // Omitting it would schedule a real rename-dialog timer that outlives
      // this test's stubbed window.
      interactiveArgs: { name: "renamed" },
      blocked: (s) => s.updateTitle,
      hitFocused: (s) =>
        expect(s.updateTitle).toHaveBeenCalledWith("focused-panel", "renamed", "automation"),
    },
    {
      id: "terminal.viewInfo",
      noTarget: OBJECT_SCHEMA,
      blocked: (s) => s.dispatchEvent,
      hitFocused: () => expectInfoEventFor("focused-panel"),
    },
    {
      id: "terminal.info.open",
      noTarget: OBJECT_SCHEMA,
      blocked: (s) => s.dispatchEvent,
      hitFocused: () => expectInfoEventFor("focused-panel"),
    },
    {
      id: "terminal.info.get",
      noTarget: OPTIONAL_SCHEMA,
      blocked: (s) => s.getInfo,
      hitFocused: (s) => expect(s.getInfo).toHaveBeenCalledWith("focused-panel"),
    },
    {
      id: "terminal.toggleInputLock",
      noTarget: OBJECT_SCHEMA,
      blocked: (s) => s.toggleInputLocked,
      hitFocused: (s) => expect(s.toggleInputLocked).toHaveBeenCalledWith("focused-panel"),
    },
    {
      id: "terminal.forceResume",
      noTarget: OBJECT_SCHEMA,
      blocked: (s) => s.forceResume,
      hitFocused: (s) => expect(s.forceResume).toHaveBeenCalledWith("focused-panel"),
    },
    {
      id: "terminal.watch",
      noTarget: OPTIONAL_SCHEMA,
      blocked: (s) => s.watchPanel,
      hitFocused: (s) => expect(s.watchPanel).toHaveBeenCalledWith("focused-panel"),
    },
  ];

  it.each(GUARDED)(
    "$id rejects agent dispatch that names no terminal, and never touches the focused one",
    async ({ id, noTarget, blocked }) => {
      const spies = setGuardState();
      const run = setupActions();

      await expect(run(id, noTarget, { dispatchSource: "agent" })).rejects.toThrow(UNBOUND_TARGET);

      expect(blocked(spies)).not.toHaveBeenCalled();
    }
  );

  it.each(GUARDED)(
    "$id still acts on the focused terminal for interactive dispatch",
    async ({ id, noTarget, interactiveArgs, hitFocused }) => {
      const spies = setGuardState();
      const run = setupActions();

      // A keybinding may legitimately omit the target — that ambient fallback
      // is the whole point, and the guard has to stay out of its way.
      const args = interactiveArgs ? { ...(noTarget as object), ...interactiveArgs } : noTarget;
      await run(id, args, { dispatchSource: "keybinding" });

      hitFocused(spies);
    }
  );

  it("lets agent dispatch through once it names a terminal, ignoring focus", async () => {
    const spies = setGuardState();
    const run = setupActions();

    await run("terminal.redraw", { terminalId: "explicit-panel" }, { dispatchSource: "agent" });

    // Agent dispatch is not foreground, so it redraws without the bypass.
    expect(spies.resetRenderer).toHaveBeenCalledWith("explicit-panel", { force: false });
    // The old `not.toHaveBeenCalledWith("focused-panel")` would now pass even if
    // the focused pane WERE redrawn, since the real call carries a second
    // argument and never matches that shape. Pin the call count and the target
    // instead, so the negative can't rot into a false positive (#11638).
    expect(spies.resetRenderer).toHaveBeenCalledTimes(1);
    expect(spies.resetRenderer.mock.calls[0]?.[0]).toBe("explicit-panel");
  });

  it("withholds the streaming-write bypass from non-foreground dispatch", async () => {
    const spies = setGuardState();
    const run = setupActions();

    // A plugin can reach this safe action through host.dispatch() on a timer.
    // That IS the automatic out-of-band writer #10863's deferral was written
    // for, so it must not inherit the human's bypass (#11638) — it still gets
    // the renderer repair, just with the guard intact.
    await run("terminal.redraw", { terminalId: "explicit-panel" }, { dispatchSource: "plugin" });

    expect(spies.resetRenderer).toHaveBeenCalledWith("explicit-panel", { force: false });
  });

  it("treats an empty terminalId as naming nothing", async () => {
    // The helper checks `!terminalId` rather than `== null`, so "" is rejected
    // like a missing target. It would not retarget focus either way — "" is not
    // nullish, so `??` keeps it — but it must be a clear error, not a silent
    // no-op an agent cannot distinguish from success.
    const spies = setGuardState();
    const run = setupActions();

    await expect(
      run("terminal.redraw", { terminalId: "" }, { dispatchSource: "agent" })
    ).rejects.toThrow(UNBOUND_TARGET);

    expect(spies.resetRenderer).not.toHaveBeenCalled();
  });

  it("refuses an unbound kill before staging a confirm dialog", async () => {
    // The severe case: terminal.kill is agent-reachable and danger:"confirm",
    // so an unguarded unbound call would ask the user to approve killing the
    // terminal they are looking at rather than the one the agent meant.
    //
    // The focused panel has to be a mid-work agent, or terminalHasRunningAgentSession
    // returns false, the confirm branch never runs for any input, and asserting
    // that it did not fire would prove nothing.
    const spies = setGuardState({
      focusedPanel: { kind: "terminal", detectedAgentId: "claude", agentState: "working" },
    });
    const run = setupActions();

    await expect(run("terminal.kill", OBJECT_SCHEMA, { dispatchSource: "agent" })).rejects.toThrow(
      UNBOUND_TARGET
    );

    expect(spies.requestConfirm).not.toHaveBeenCalled();
    expect(spies.removePanel).not.toHaveBeenCalled();
  });

  it("stages the confirm dialog for the terminal the agent named", async () => {
    // The companion to the test above: with the guard satisfied, the confirm
    // path is demonstrably live, so the assertion there is not vacuous.
    const spies = setGuardState({
      focusedPanel: { kind: "terminal", detectedAgentId: "claude", agentState: "working" },
    });
    panelStoreMock.getState.mockImplementation(() => ({
      focusedId: "focused-panel",
      panelIds: ["focused-panel", "explicit-panel"],
      panelsById: {
        "focused-panel": { id: "focused-panel", location: "grid" },
        "explicit-panel": {
          id: "explicit-panel",
          location: "grid",
          kind: "terminal",
          detectedAgentId: "claude",
          agentState: "working",
        },
      },
      watchedPanels: new Set<string>(),
      removePanel: spies.removePanel,
    }));
    const run = setupActions();

    // Agent source alone is NOT approval — only a host-attested `hostConfirmed`
    // is (#12120). An agent that reached run() without one still stages, and now
    // fails rather than reporting a kill it did not perform.
    await expect(
      run("terminal.kill", { terminalId: "explicit-panel" }, { dispatchSource: "agent" })
    ).rejects.toThrow(/needs confirmation/);

    expect(spies.requestConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "kill", terminalId: "explicit-panel" })
    );
    expect(spies.removePanel).not.toHaveBeenCalled();
  });

  describe("terminal.rename headless name binding", () => {
    it("rejects agent dispatch with a target but no name instead of opening the dialog", async () => {
      const spies = setGuardState();
      const run = setupActions();

      await expect(
        run("terminal.rename", { terminalId: "explicit-panel" }, { dispatchSource: "agent" })
      ).rejects.toThrow(/requires an explicit `name` when dispatched by an agent or MCP client/);

      expect(spies.updateTitle).not.toHaveBeenCalled();
      expect(spies.dispatchEvent).not.toHaveBeenCalled();
    });

    it("reports the missing target first when both are absent", async () => {
      setGuardState();
      const run = setupActions();

      await expect(
        run("terminal.rename", OBJECT_SCHEMA, { dispatchSource: "agent" })
      ).rejects.toThrow(UNBOUND_TARGET);
    });

    it("renames when the agent supplies both", async () => {
      const spies = setGuardState();
      const run = setupActions();

      await run(
        "terminal.rename",
        { terminalId: "explicit-panel", name: "build" },
        { dispatchSource: "agent" }
      );

      expect(spies.updateTitle).toHaveBeenCalledWith("explicit-panel", "build", "automation");
    });

    it("accepts an empty name, which restores the default title", async () => {
      // "" is a meaningful value, not a missing one — the guard tests
      // `name === undefined` so this path stays reachable.
      const spies = setGuardState();
      const run = setupActions();

      await run(
        "terminal.rename",
        { terminalId: "explicit-panel", name: "" },
        { dispatchSource: "agent" }
      );

      expect(spies.updateTitle).toHaveBeenCalledWith("explicit-panel", "", "automation");
    });

    // The runbook confirmed every rename with a second terminal.list, only to
    // learn whether a hand-set title had kept its place.
    it.each([
      { userLocked: false, expected: { title: "build", applied: true } },
      { userLocked: true, expected: { title: "my title", applied: false } },
    ])(
      "reports the title the tab shows (user lock: $userLocked)",
      async ({ userLocked, expected }) => {
        setGuardState();
        const run = setupActions();
        let title = "my title";
        const base = panelStoreMock.getState.getMockImplementation()!;
        panelStoreMock.getState.mockImplementation(() => {
          const state = base() as { panelsById: Record<string, unknown> };
          return {
            ...state,
            updateTitle: (_id: string, name: string) => {
              if (!userLocked) title = name.trim();
            },
            panelsById: {
              ...state.panelsById,
              "explicit-panel": {
                id: "explicit-panel",
                location: "grid",
                title,
                titleMode: userLocked ? "user" : "custom",
              },
            },
          };
        });

        const result = await run(
          "terminal.rename",
          { terminalId: "explicit-panel", name: "build " },
          { dispatchSource: "agent" }
        );

        expect(result).toEqual({ terminalId: "explicit-panel", ...expected });
      }
    );
  });

  describe("terminal.info.get guard composition", () => {
    it("gives an agent the binding error even while a terminal is focused", async () => {
      // The pre-existing "No terminal selected" throw only fires when nothing
      // is focused either, so on its own it would let an agent silently read
      // the wrong terminal.
      const spies = setGuardState({ focusedId: "focused-panel" });
      const run = setupActions();

      await expect(
        run("terminal.info.get", OPTIONAL_SCHEMA, { dispatchSource: "agent" })
      ).rejects.toThrow(UNBOUND_TARGET);

      expect(spies.getInfo).not.toHaveBeenCalled();
    });

    it("keeps the focus fallback for interactive dispatch", async () => {
      const spies = setGuardState({ focusedId: "focused-panel" });
      const run = setupActions();

      await run("terminal.info.get", undefined, { dispatchSource: "menu" });

      expect(spies.getInfo).toHaveBeenCalledWith("focused-panel");
    });

    it("keeps 'No terminal selected' for interactive dispatch with nothing focused", async () => {
      setGuardState({ focusedId: null });
      const run = setupActions();

      await expect(run("terminal.info.get", undefined, { dispatchSource: "menu" })).rejects.toThrow(
        "No terminal selected"
      );
    });
  });
});

// #12120: the MCP bridge sets the approval in the dispatch OPTIONS and leaves
// the model's args alone, so `run()` could only see the client-settable
// `args.confirmed` — it re-asked after the host modal was already approved,
// staged a second dialog, and returned `ok` on a terminal that was still alive.
// `ctx.hostConfirmed` is the attestation ActionService stamps from those options.
describe("host-attested confirmation (#12120)", () => {
  const WORKING_AGENT = {
    location: "grid" as const,
    detectedAgentId: "claude",
    agentState: "working",
  };

  it("kills a running-agent terminal without staging a second confirmation", async () => {
    const { removePanel } = setRichPanelState({
      focusedId: "p1",
      panels: [{ id: "p1", ...WORKING_AGENT }],
    });
    const run = setupActions();

    await run("terminal.kill", { terminalId: "p1" }, { hostConfirmed: true });

    expect(removePanel).toHaveBeenCalledWith("p1");
    expect(pendingDestructiveStoreMock.state.request).not.toHaveBeenCalled();
  });

  it("restarts a running-agent terminal without staging a second confirmation", async () => {
    const { restartTerminal } = setRichPanelState({
      focusedId: "p1",
      panels: [{ id: "p1", ...WORKING_AGENT }],
    });
    const run = setupActions();

    await run("terminal.restart", { terminalId: "p1" }, { hostConfirmed: true });

    expect(restartTerminal).toHaveBeenCalledWith("p1");
    expect(pendingDestructiveStoreMock.state.request).not.toHaveBeenCalled();
  });

  // killAll/restartAll took no `ctx` at all before this fix, so they could not
  // have read the attestation even if it existed.
  it("kills all without staging a second confirmation", async () => {
    const { removePanel } = setRichPanelState({
      panels: [
        { id: "p1", location: "grid" },
        { id: "p2", ...WORKING_AGENT },
      ],
    });
    const run = setupActions();

    await run("terminal.killAll", undefined, { hostConfirmed: true });

    expect(removePanel).toHaveBeenCalledWith("p1");
    expect(removePanel).toHaveBeenCalledWith("p2");
    expect(pendingDestructiveStoreMock.state.request).not.toHaveBeenCalled();
  });

  it("restarts all without staging a second confirmation", async () => {
    const { bulkRestartAll } = setRichPanelState({
      panels: [
        { id: "p1", location: "grid" },
        { id: "p2", ...WORKING_AGENT },
      ],
    });
    const run = setupActions();

    await run("terminal.restartAll", undefined, { hostConfirmed: true });

    expect(bulkRestartAll).toHaveBeenCalled();
    expect(pendingDestructiveStoreMock.state.request).not.toHaveBeenCalled();
  });

  // Only `true` attests. A stray falsy/garbage value must fall through to the
  // confirmation rather than be read as approval.
  it.each([[false], [undefined], ["true"]])(
    "does not treat hostConfirmed=%p as approval",
    async (hostConfirmed) => {
      const { removePanel } = setRichPanelState({
        focusedId: "p1",
        panels: [{ id: "p1", ...WORKING_AGENT }],
      });
      const run = setupActions();

      await expect(run("terminal.kill", { terminalId: "p1" }, { hostConfirmed })).rejects.toThrow(
        /needs confirmation/
      );

      expect(removePanel).not.toHaveBeenCalled();
      expect(pendingDestructiveStoreMock.state.request).toHaveBeenCalled();
    }
  );

  // The user-facing dialog re-dispatches with args.confirmed; a host-attested
  // dispatch arrives with neither that nor any pending entry of its own. Both
  // paths must clear a parked confirmation so it can't outlive the kill.
  it("clears a parked confirmation when the host attested instead", async () => {
    const { removePanel } = setRichPanelState({
      focusedId: "p1",
      panels: [{ id: "p1", ...WORKING_AGENT }],
    });
    const run = setupActions();

    await expect(run("terminal.kill", { terminalId: "p1" })).rejects.toThrow();
    expect(pendingDestructiveStoreMock.state.pending).toMatchObject({ kind: "kill" });

    await run("terminal.kill", { terminalId: "p1" }, { hostConfirmed: true });

    expect(removePanel).toHaveBeenCalledWith("p1");
    expect(pendingDestructiveStoreMock.state.clear).toHaveBeenCalled();
  });
});

describe("terminal.revealOwned (#12315)", () => {
  function definition(): AnyActionDefinition {
    const actions: ActionRegistry = new Map();
    registerTerminalLifecycleActions(actions, {} as ActionCallbacks);
    const factory = actions.get("terminal.revealOwned");
    if (!factory) throw new Error("terminal.revealOwned is not registered");
    return factory() as AnyActionDefinition;
  }

  it("refuses a direct renderer dispatch", async () => {
    // The authorization is the MCP session's ownership ledger, which is
    // main-process state the renderer cannot see and must never be told. A
    // renderer that could run this would be answering "am I allowed?" about
    // itself.
    await expect(definition().run({ terminalId: "p1" }, {} as never)).rejects.toThrow(
      /main-process path/
    );
  });

  it("requires a non-empty terminal id with no focused-panel fallback", () => {
    // The focused panel is by definition already in front of the user, and it
    // is rarely one this session owns.
    const schema = definition().argsSchema;
    expect(schema?.safeParse({ terminalId: "" }).success).toBe(false);
    expect(schema?.safeParse({}).success).toBe(false);
    expect(schema?.safeParse({ terminalId: "terminal-1" }).success).toBe(true);
  });
});

describe("restored panes and the plugin hold (#14017)", () => {
  const getInfo = vi.fn();
  const setHoldOnRestart = vi.fn();
  const lastSeen = { agentState: "idle", at: 4_000 };

  function setPanels(panels: Record<string, Record<string, unknown>>) {
    panelStoreMock.getState.mockImplementation(() => ({
      focusedId: null,
      panelIds: Object.keys(panels),
      panelsById: panels,
      setHoldOnRestart,
    }));
  }

  function definition(id: string): AnyActionDefinition {
    const actions: ActionRegistry = new Map();
    registerTerminalLifecycleActions(actions, {} as ActionCallbacks);
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    return factory() as AnyActionDefinition;
  }

  beforeEach(() => {
    getInfo.mockReset();
    vi.stubGlobal("window", { electron: { terminal: { getInfo } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("terminal.info.get", () => {
    it("answers for a held pane from the pane itself, with no process measurements", async () => {
      setPanels({
        held: {
          id: "held",
          kind: "terminal",
          location: "grid",
          launchAgentId: "claude",
          title: "Claude",
          cwd: "/repo",
          command: "claude",
          agentModelId: "opus",
          restoreRecovery: { reason: "resume-deferred", sessionId: "sess-c" },
          restoreProvenance: { at: 5_000, disposition: "held", lastSeen },
        },
      });
      const def = definition("terminal.info.get");

      const info = await def.run({ terminalId: "held" }, {} as never);

      expect(getInfo).not.toHaveBeenCalled();
      expect(info).toEqual({
        id: "held",
        kind: "terminal",
        launchAgentId: "claude",
        title: "Claude",
        cwd: "/repo",
        command: "claude",
        hasPty: false,
        agentModelId: "opus",
        restored: { at: 5_000, disposition: "held", heldReason: "resume-deferred", lastSeen },
      });
      expect(info).not.toHaveProperty("spawnedAt");
      expect(JSON.stringify(info)).not.toContain("sess-c");
      // What dispatch delivers is the parse, which strips anything undeclared.
      expect(def.resultSchema?.parse(info)).toMatchObject({
        hasPty: false,
        restored: { at: 5_000, disposition: "held", heldReason: "resume-deferred", lastSeen },
      });
    });

    it("adds how restore brought a live pane back to the host's record", async () => {
      setPanels({
        live: {
          id: "live",
          kind: "terminal",
          location: "grid",
          cwd: "/repo",
          restoreProvenance: { at: 5_000, disposition: "resume", lastSeen },
        },
      });
      getInfo.mockResolvedValue({
        id: "live",
        cwd: "/repo",
        spawnedAt: 5_001,
        lastInputTime: 0,
        lastOutputTime: 5_100,
        activityTier: "focused",
        outputBufferSize: 10,
        semanticBufferLines: 2,
        restartCount: 0,
        hasPty: true,
      });
      const def = definition("terminal.info.get");

      const info = await def.run({ terminalId: "live" }, {} as never);

      expect(getInfo).toHaveBeenCalledWith("live");
      expect(info).toMatchObject({
        spawnedAt: 5_001,
        hasPty: true,
        restored: { at: 5_000, disposition: "resume", lastSeen },
      });
      expect(def.resultSchema?.parse(info)).toMatchObject({
        restored: { at: 5_000, disposition: "resume", lastSeen },
      });
    });

    it("reports no restore for a pane restore never rebuilt", async () => {
      setPanels({ fresh: { id: "fresh", kind: "terminal", location: "grid", cwd: "/repo" } });
      getInfo.mockResolvedValue({ id: "fresh", cwd: "/repo", spawnedAt: 1 });

      const info = await definition("terminal.info.get").run({ terminalId: "fresh" }, {} as never);

      expect(info).not.toHaveProperty("restored");
    });
  });

  describe("terminal.setHoldOnRestart", () => {
    const pluginCtx = { dispatchSource: "plugin", callerPluginId: "acme.orchestrator" };

    beforeEach(() => {
      setHoldOnRestart.mockReset();
      setPanels({
        own: {
          id: "own",
          kind: "terminal",
          location: "grid",
          launchAgentId: "claude",
          launchedByPluginId: "acme.orchestrator",
        },
        foreign: {
          id: "foreign",
          kind: "terminal",
          location: "grid",
          launchAgentId: "claude",
          launchedByPluginId: "other.plugin",
        },
        user: { id: "user", kind: "terminal", location: "grid", launchAgentId: "claude" },
        // A plain shell restore never holds, so no receipt may claim it will.
        shell: {
          id: "shell",
          kind: "terminal",
          location: "grid",
          launchedByPluginId: "acme.orchestrator",
        },
      });
    });

    it("holds and releases a pane the calling plugin launched", async () => {
      const def = definition("terminal.setHoldOnRestart");

      await expect(def.run({ terminalId: "own", hold: true }, pluginCtx as never)).resolves.toEqual(
        { terminalId: "own", holdOnRestart: true }
      );
      await def.run({ terminalId: "own", hold: false }, pluginCtx as never);

      expect(setHoldOnRestart.mock.calls).toEqual([
        ["own", true],
        ["own", false],
      ]);
    });

    it.each(["foreign", "user", "shell", "missing"])(
      "refuses the %s pane, which this plugin did not launch",
      async (terminalId) => {
        await expect(
          definition("terminal.setHoldOnRestart").run(
            { terminalId, hold: true },
            pluginCtx as never
          )
        ).rejects.toThrow(/launched by this plugin/);
        expect(setHoldOnRestart).not.toHaveBeenCalled();
      }
    );

    it.each([
      { dispatchSource: "agent" },
      { dispatchSource: "user" },
      // A context override can't claim a plugin: only ActionService stamps it.
      { dispatchSource: "agent", callerPluginId: "acme.orchestrator" },
      { dispatchSource: "plugin" },
    ])("refuses a dispatch with no plugin behind it (%o)", async (ctx) => {
      await expect(
        definition("terminal.setHoldOnRestart").run({ terminalId: "own", hold: true }, ctx as never)
      ).rejects.toThrow(/Only the plugin that launched/);
      expect(setHoldOnRestart).not.toHaveBeenCalled();
    });

    it("reaches the action only as the plugin the host says is calling", async () => {
      const { ActionService } = await import("../../../ActionService");
      const service = new ActionService();
      service.register(definition("terminal.setHoldOnRestart"));
      const id = "terminal.setHoldOnRestart" as ActionId;
      const args = { terminalId: "own", hold: true };

      const own = await service.dispatch(id, args, {
        source: "plugin",
        callerPluginId: "acme.orchestrator",
      });
      const foreign = await service.dispatch(id, args, {
        source: "plugin",
        callerPluginId: "other.plugin",
      });
      // A context override can't name the plugin; only the bridge's own option can.
      const forged = await service.dispatch(id, args, {
        source: "agent",
        contextOverride: { dispatchSource: "plugin", callerPluginId: "acme.orchestrator" },
      });

      expect(own).toMatchObject({ ok: true, result: { terminalId: "own", holdOnRestart: true } });
      expect(foreign.ok).toBe(false);
      expect(forged.ok).toBe(false);
      expect(setHoldOnRestart.mock.calls).toEqual([["own", true]]);
    });

    it("stays out of the palette and off MCP", () => {
      const def = definition("terminal.setHoldOnRestart");
      expect(def.palette).toEqual({ mode: "hidden" });
      expect(def.mcpVisibility).toBe("hidden");
    });
  });
});

describe("terminal.sessionFile.get (#16097)", () => {
  const get = vi.fn();
  const observed = {
    status: "observed",
    agentId: "codex",
    sessionId: "01a19a09-d462-7101-a841-24b57d849008",
    path: "/Users/x/.codex/sessions/2026/11/02/rollout-2026-11-02T04-14-57-01a19a09-d462-7101-a841-24b57d849008.jsonl",
    observedBy: "open-for-writing",
  };

  function definition(): AnyActionDefinition {
    const actions: ActionRegistry = new Map();
    registerTerminalLifecycleActions(actions, {} as ActionCallbacks);
    const factory = actions.get("terminal.sessionFile.get");
    if (!factory) throw new Error("missing terminal.sessionFile.get");
    return factory() as AnyActionDefinition;
  }

  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue(observed);
    vi.stubGlobal("window", { electron: { terminalSessionFile: { get } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks main for the named terminal on a plugin's behalf", async () => {
    await expect(
      definition().run({ terminalId: "term-1" }, {
        dispatchSource: "plugin",
        callerPluginId: "acme.handoff",
      } as never)
    ).resolves.toEqual(observed);
    expect(get).toHaveBeenCalledWith({ terminalId: "term-1" });
  });

  it.each([
    { dispatchSource: "agent" },
    { dispatchSource: "user" },
    { dispatchSource: "agent", callerPluginId: "acme.handoff" },
    { dispatchSource: "plugin" },
  ])("refuses a dispatch with no plugin behind it (%o)", async (ctx) => {
    await expect(definition().run({ terminalId: "term-1" }, ctx as never)).rejects.toThrow(
      /Only a plugin/
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("requires a terminal id, with no focused-panel fallback", () => {
    const schema = definition().argsSchema;
    expect(schema?.safeParse({}).success).toBe(false);
    expect(schema?.safeParse({ terminalId: "  " }).success).toBe(false);
    expect(schema?.safeParse({ terminalId: "term-1" }).success).toBe(true);
  });

  it("delivers both answers through its result schema whole", () => {
    const schema = definition().resultSchema;
    expect(schema?.parse(observed)).toEqual(observed);
    const unknown = { status: "unknown", reason: "store-unknown" };
    expect(schema?.parse(unknown)).toEqual(unknown);
    expect(schema?.safeParse({ status: "unknown", reason: "guessed" }).success).toBe(false);
  });

  it("reaches dispatch only as the plugin the host says is calling", async () => {
    const { ActionService } = await import("../../../ActionService");
    const service = new ActionService();
    service.register(definition());
    const id = "terminal.sessionFile.get" as ActionId;

    const plugin = await service.dispatch(
      id,
      { terminalId: "term-1" },
      { source: "plugin", callerPluginId: "acme.handoff" }
    );
    const forged = await service.dispatch(
      id,
      { terminalId: "term-1" },
      {
        source: "agent",
        contextOverride: { dispatchSource: "plugin", callerPluginId: "acme.handoff" },
      }
    );

    expect(plugin).toMatchObject({ ok: true, result: observed });
    expect(forged.ok).toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("stays out of the palette and off MCP", () => {
    const def = definition();
    expect(def.palette).toEqual({ mode: "hidden" });
    expect(def.mcpVisibility).toBe("hidden");
  });
});
