// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  // Lets a test swap in the real `trashPanel`'s other two outcomes: removing the
  // record outright (remove-on-exit / dialog panels route to `removePanel`), and
  // failing (the coordinator swallows a commit that throws).
  const override = { trash: null as null | ((id: string) => void) };
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
      if (override.trash) {
        override.trash(id);
        return;
      }
      const panel = state.panelsById[id];
      if (panel) state.panelsById[id] = { ...panel, location: "trash" };
    }),
  };
  return { state, override };
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
// The coordinator logs a commit that throws; one test provokes that on purpose,
// and the real logger would print the stack as if the run had broken.
vi.mock("@/utils/logger", () => ({ logError: vi.fn(), logWarn: vi.fn(), logDebug: vi.fn() }));

import { ActionService } from "../../../ActionService";
import { registerTerminalLifecycleActions } from "../terminalLifecycleActions";
import { registerTerminalQueryActions } from "../terminalQueryActions";
import {
  requestPanelClose,
  __resetOptimisticPanelCloseForTests,
} from "@/services/terminal/optimisticPanelClose";

const WORKTREE = "wt1";

function seed(panels: MockPanel[], focusedId: string | null = null): void {
  store.override.trash = null;
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
    // Reset here as well as in `seed()`, so a test that never seeds cannot
    // inherit the previous one's trash behavior.
    store.override.trash = null;
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("still defers the teardown for a foreground close, and names what it accepted", async () => {
    seed([
      { id: "a", kind: "terminal", location: "grid" },
      { id: "b", kind: "terminal", location: "grid" },
    ]);
    const service = buildService();

    const closed = await service.dispatch<{ closedIds: string[] }>(
      "terminal.close",
      { terminalId: "a" },
      { source: "keybinding" }
    );

    // The paint-frame protection the optimistic path exists for is intact: the
    // canonical trash has not run yet. The result still names the panel, so a
    // foreground caller is not told the close was a no-op.
    expect(closed.ok && closed.result).toEqual({ closedIds: ["a"] });
    expect(await listedIds(service)).toEqual(["a", "b"]);
    // Advance to the queued commit rather than a literal delay — the coordinator
    // owns the wait, and this asserts only that it eventually runs.
    await vi.runOnlyPendingTimersAsync();
    expect(await listedIds(service)).toEqual(["b"]);
  });

  it("treats a source-less dispatch as foreground, matching ActionService's default", async () => {
    seed([{ id: "a", kind: "terminal", location: "grid" }]);
    const service = buildService();

    // ActionService defaults an omitted source to "user", so the in-app close
    // paths that pass no source keep the deferral rather than paying for a
    // synchronous teardown on every Cmd+W.
    const closed = await service.dispatch<{ closedIds: string[] }>("terminal.close", {
      terminalId: "a",
    });

    expect(closed.ok && closed.result).toEqual({ closedIds: ["a"] });
    expect(await listedIds(service)).toEqual(["a"]);
  });

  it("closes synchronously for plugin dispatch too, not just agent", async () => {
    seed([{ id: "a", kind: "terminal", location: "grid" }]);
    const service = buildService();

    // The gate is an allowlist of foreground sources, so "plugin" gets the same
    // read-your-writes guarantee without being named anywhere.
    const closed = await service.dispatch<{ closedIds: string[] }>(
      "terminal.close",
      { terminalId: "a" },
      { source: "plugin" }
    );

    expect(closed.ok && closed.result).toEqual({ closedIds: ["a"] });
    expect(await listedIds(service)).toEqual([]);
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

  // "constructor" is a real panel id here (an own key shadowing the prototype),
  // which is what makes this a regression test for the projection rather than
  // just the happy path: judging "gone" by `panelsById[id] === undefined` finds
  // the inherited function instead and reports the close as a no-op.
  it.each(["a", "constructor"])("reports the panel %s removed outright as closed", async (id) => {
    seed([{ id, kind: "terminal", location: "grid" }]);
    // Remove-on-exit and dialog panels bypass trash: `trashPanel` routes them to
    // `removePanel`, so the record is gone rather than relocated. Judging that by
    // location alone would report the close as a no-op.
    store.override.trash = (target) => {
      delete store.state.panelsById[target];
      store.state.panelIds = store.state.panelIds.filter((panelId) => panelId !== target);
    };
    const service = buildService();

    const closed = await service.dispatch<{ closedIds: string[] }>(
      "terminal.close",
      { terminalId: id },
      { source: "agent" }
    );

    expect(closed.ok && closed.result).toEqual({ closedIds: [id] });
    expect(await listedIds(service)).toEqual([]);
  });

  it("reports nothing closed when the teardown fails", async () => {
    seed([{ id: "a", kind: "terminal", location: "grid" }]);
    // The coordinator catches a commit that throws so one failure cannot take
    // out the rest of the batch. The panel is still open, so the ack must not
    // claim otherwise.
    store.override.trash = () => {
      throw new Error("trash failed");
    };
    const service = buildService();

    const closed = await service.dispatch<{ closedIds: string[] }>(
      "terminal.close",
      { terminalId: "a" },
      { source: "agent" }
    );

    expect(closed.ok && closed.result).toEqual({ closedIds: [] });
    expect(await listedIds(service)).toEqual(["a"]);
  });

  it.each(["stale", "constructor"])(
    "closes nothing when focus points at the missing panel %s",
    async (focusedId) => {
      seed([{ id: "a", kind: "terminal", location: "grid" }], focusedId);
      const service = buildService();

      // No explicit id, so the target resolves from focus — which can outlive
      // the panel it names. "constructor" additionally proves the focus branch
      // does its own own-property check: a plain lookup resolves it off the
      // prototype and trashes a panel that never existed.
      const closed = await service.dispatch<{ closedIds: string[] }>("terminal.close", undefined, {
        source: "keybinding",
      });

      expect(closed.ok && closed.result).toEqual({ closedIds: [] });
      expect(store.state.trashPanel).not.toHaveBeenCalled();
      expect(await listedIds(service)).toEqual(["a"]);
    }
  );

  it.each(["constructor", "__proto__", "toString"])(
    "rejects the inherited key %s rather than trashing it",
    async (terminalId) => {
      seed([{ id: "a", kind: "terminal", location: "grid" }]);
      const service = buildService();

      // `panelsById` is a plain object, so a truthiness check would resolve these
      // off Object.prototype and run the whole trash flow on a panel that never
      // existed.
      const closed = await service.dispatch("terminal.close", { terminalId }, { source: "agent" });

      expect(closed.ok).toBe(false);
      expect(!closed.ok && closed.error.code).toBe("EXECUTION_ERROR");
      expect(store.state.trashPanel).not.toHaveBeenCalled();
      expect(await listedIds(service)).toEqual(["a"]);
    }
  );

  it("closes a tracked panel that has not reached panelIds yet", async () => {
    seed([]);
    // Hydration commits `panelsById` before `panelIds`, so membership in the id
    // list is not what makes a panel real. Gating the guard on `panelIds` would
    // reject a genuinely tracked panel during that window.
    store.state.panelsById = { a: { id: "a", kind: "terminal", location: "grid" } };
    const service = buildService();

    const closed = await service.dispatch<{ closedIds: string[] }>(
      "terminal.close",
      { terminalId: "a" },
      { source: "agent" }
    );

    expect(closed.ok && closed.result).toEqual({ closedIds: ["a"] });
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
