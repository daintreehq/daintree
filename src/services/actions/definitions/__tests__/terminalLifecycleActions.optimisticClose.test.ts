// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionId } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

/**
 * The read-your-writes half of #11805, run against the REAL optimistic-close
 * coordinator.
 *
 * terminalLifecycleActions.test.ts mocks that coordinator so its commit runs
 * synchronously, which makes it structurally unable to catch this bug: the
 * whole defect is that the commit does NOT run before `terminal.close`
 * resolves. Asserting there that a mocked `flushOptimisticCloses` was called
 * proves the call, not the postcondition. So this file wires the real
 * coordinator to a real ActionService and asserts what an MCP caller actually
 * observes — whether the panel is still in `terminal.list` the moment the close
 * acks — with timers frozen so any reliance on the deferred flush fails.
 */

// ActionService pulls in the shortcut-hint store, keybinding service, and
// notify at module load / dispatch time; none are under test here.
vi.mock("../../../../store/shortcutHintStore", () => ({
  shortcutHintStore: {
    getState: vi.fn(() => ({ counts: {}, show: vi.fn(), incrementCount: vi.fn() })),
  },
}));
vi.mock("../../../KeybindingService", () => ({
  keybindingService: { getEffectiveCombo: vi.fn(() => null), getDisplayCombo: vi.fn(() => "") },
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

interface MockPanel {
  id: string;
  kind: string;
  location: "grid" | "dock" | "trash" | "background";
  worktreeId?: string;
  title?: string;
}

// One store object behind both module specifiers: the action reads
// `@/store/panelStore` while the coordinator reads `@/store`. Two separate
// mocks would let the action see a trash that the coordinator never wrote.
const store = vi.hoisted(() => {
  const state = {
    focusedId: null as string | null,
    panelIds: [] as string[],
    panelsById: {} as Record<string, { id: string; kind: string; location: string }>,
    setFocused: vi.fn((id: string | null) => {
      state.focusedId = id;
    }),
    getTabGroups: undefined,
    // Mirrors the real `trashPanel`: the record survives, its location becomes
    // "trash", and `terminal.list` filters on exactly that.
    trashPanel: vi.fn((id: string) => {
      const panel = state.panelsById[id];
      if (panel) state.panelsById[id] = { ...panel, location: "trash" };
    }),
  };
  return { state };
});

vi.mock("@/store", () => ({ panelStoreApi: { getState: () => store.state } }));
vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: () => store.state } }));
vi.mock("@/store/fleetArmingStore", () => ({
  useFleetArmingStore: { getState: () => ({ armedIds: new Set<string>() }) },
}));
vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: { focus: vi.fn() },
}));
vi.mock("@/services/terminal/TerminalInstanceService", () => ({
  terminalInstanceService: {
    focus: vi.fn(),
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    resetRenderer: vi.fn(),
  },
}));
vi.mock("@/clients", () => ({
  terminalClient: { submit: vi.fn(), killTerminal: vi.fn(), forceResume: vi.fn() },
}));
vi.mock("@/lib/watchNotification", () => ({ fireWatchNotification: vi.fn() }));
vi.mock("@/store/terminalPendingDestructiveActionStore", () => ({
  useTerminalPendingDestructiveActionStore: {
    getState: () => ({ pending: null, request: vi.fn(), clear: vi.fn() }),
  },
}));
const PTY_KINDS = new Set(["terminal", "agent"]);
vi.mock("@shared/config/panelKindRegistry", () => ({
  panelKindHasPty: (kind: string) => PTY_KINDS.has(kind),
}));

import { ActionService } from "../../../ActionService";
import { registerTerminalLifecycleActions } from "../terminalLifecycleActions";
import { registerTerminalQueryActions } from "../terminalQueryActions";
import {
  requestPanelClose,
  __resetOptimisticPanelCloseForTests,
} from "@/services/terminal/optimisticPanelClose";

const WORKTREE = "wt1";

function seed(panels: MockPanel[], focusedId: string | null = null): void {
  store.state.panelIds = panels.map((p) => p.id);
  store.state.panelsById = {};
  for (const panel of panels) {
    store.state.panelsById[panel.id] = {
      worktreeId: WORKTREE,
      title: panel.id,
      ...panel,
    } as MockPanel & { id: string; kind: string; location: string };
  }
  store.state.focusedId = focusedId;
}

function buildService(): ActionService {
  const registry: ActionRegistry = new Map();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ActionCallbacks has ~40 members; terminal.closeAll reads only this one.
  const callbacks = { getActiveWorktreeId: () => WORKTREE } as ActionCallbacks;
  registerTerminalLifecycleActions(registry, callbacks);
  registerTerminalQueryActions(registry, callbacks);
  const service = new ActionService();
  for (const [, factory] of registry) {
    service.register(factory() as AnyActionDefinition);
  }
  return service;
}

/** The ids an MCP caller would see in `terminal.list` right now. */
async function listedIds(service: ActionService): Promise<string[]> {
  const listed = await service.dispatch<{ terminals: Array<{ id: string }> }>("terminal.list");
  if (!listed.ok) throw new Error(`terminal.list failed: ${listed.error.code}`);
  return listed.result.terminals.map((t) => t.id);
}

describe("terminal.close read-your-writes against the real coordinator (#11805)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetOptimisticPanelCloseForTests();
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("has already left terminal.list when an agent close resolves", async () => {
    seed([
      { id: "a", kind: "terminal", location: "grid" },
      { id: "b", kind: "terminal", location: "grid" },
    ]);
    const service = buildService();

    const closed = await service.dispatch(
      "terminal.close",
      { terminalId: "a" },
      { source: "agent" }
    );

    // No timer advance anywhere in this test: the deferred flush is exactly what
    // must NOT be load-bearing for an automated caller.
    expect(closed.ok).toBe(true);
    expect(closed.ok && closed.result).toEqual({ closedIds: ["a"] });
    expect(await listedIds(service)).toEqual(["b"]);
  });

  it("still defers the teardown for a foreground close", async () => {
    seed([
      { id: "a", kind: "terminal", location: "grid" },
      { id: "b", kind: "terminal", location: "grid" },
    ]);
    const service = buildService();

    await service.dispatch("terminal.close", { terminalId: "a" }, { source: "keybinding" });

    // The paint-frame protection the optimistic path exists for is intact: the
    // canonical trash has not run yet.
    expect(await listedIds(service)).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(200);
    expect(await listedIds(service)).toEqual(["b"]);
  });

  it("treats a source-less dispatch as foreground, matching ActionService's default", async () => {
    seed([{ id: "a", kind: "terminal", location: "grid" }]);
    const service = buildService();

    // ActionService defaults an omitted source to "user", so the in-app close
    // paths that pass no source keep the deferral rather than paying for a
    // synchronous teardown on every Cmd+W.
    await service.dispatch("terminal.close", { terminalId: "a" });

    expect(await listedIds(service)).toEqual(["a"]);
  });

  it("resolves truthfully when the panel is already mid-close", async () => {
    seed([{ id: "a", kind: "terminal", location: "grid" }]);
    const service = buildService();
    const commit = vi.fn(() => store.state.trashPanel("a"));
    // A foreground close is already queued for this panel, so the agent's own
    // requestPanelClose is dropped as a duplicate and queues nothing. The flush
    // still has to commit the earlier request for the ack to be honest.
    requestPanelClose({ hideIds: ["a"], commit });

    const closed = await service.dispatch(
      "terminal.close",
      { terminalId: "a" },
      { source: "agent" }
    );

    expect(commit).toHaveBeenCalledTimes(1);
    expect(closed.ok && closed.result).toEqual({ closedIds: ["a"] });
    expect(await listedIds(service)).toEqual([]);
  });

  it("rejects an id that is not tracked instead of acking it", async () => {
    seed([{ id: "a", kind: "terminal", location: "grid" }]);
    const service = buildService();

    const closed = await service.dispatch(
      "terminal.close",
      { terminalId: "ghost" },
      { source: "agent" }
    );

    expect(closed.ok).toBe(false);
    expect(!closed.ok && closed.error.code).toBe("EXECUTION_ERROR");
    expect(await listedIds(service)).toEqual(["a"]);
  });

  it("clears the active worktree when an agent closes all", async () => {
    seed([
      { id: "a", kind: "terminal", location: "grid" },
      { id: "b", kind: "terminal", location: "grid" },
    ]);
    const service = buildService();

    const closed = await service.dispatch("terminal.closeAll", undefined, { source: "agent" });

    expect(closed.ok && closed.result).toEqual({ closedIds: ["a", "b"] });
    expect(await listedIds(service)).toEqual([]);
  });

  it("advertises an object outputSchema carrying closedIds for both close actions", () => {
    const service = buildService();

    for (const id of ["terminal.close", "terminal.closeAll"]) {
      // buildToolOutputSchema (tierAuth) forwards only object-typed schemas, so
      // a non-object root would silently drop structuredContent rather than
      // fail. Asserting the generated schema catches that; asserting the
      // `mcpOutputSchema` flag would not.
      const schema = service.get(id as ActionId)?.outputSchema as
        { type?: string; properties?: Record<string, unknown> } | undefined;
      expect(schema?.type, id).toBe("object");
      expect(schema?.properties?.closedIds, id).toBeDefined();
    }
  });
});
