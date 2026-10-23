import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";

const m = vi.hoisted(() => ({
  implLoads: 0,
  runLookups: 0,
  failImpl: false,
  kill: vi.fn(),
}));

const noCallbacks: ActionCallbacks = Object.create(null);

// Registered per test after the reset, so each import evaluates the module
// afresh: `implLoads` counts real loads, a throw here is a rejected import, and
// the getter counts lookups.
function mockImpl(): void {
  vi.doMock("../terminalLifecycleActions.impl", () => {
    m.implLoads++;
    if (m.failImpl) throw new Error("chunk load failed");
    return {
      get terminalLifecycleActionRuns() {
        m.runLookups++;
        return { "terminal.kill": m.kill };
      },
    };
  });
}

const ctx: ActionContext = { dispatchSource: "agent" };

async function register(callbacks = noCallbacks): Promise<ActionRegistry> {
  const { registerTerminalLifecycleActions } = await import("../terminalLifecycleActions");
  const actions: ActionRegistry = new Map();
  registerTerminalLifecycleActions(actions, callbacks);
  return actions;
}

describe("terminal lifecycle action run bodies (#14273)", () => {
  beforeEach(() => {
    vi.resetModules();
    mockImpl();
    m.implLoads = 0;
    m.runLookups = 0;
    m.failImpl = false;
    m.kill.mockReset().mockResolvedValue({ killed: true });
  });

  it("registers and materializes every definition without touching the run bodies", async () => {
    const actions = await register();
    for (const create of actions.values()) create();
    expect(actions.size).toBeGreaterThan(0);
    expect(m.implLoads).toBe(0);
    expect(m.runLookups).toBe(0);
  });

  it("loads the run bodies on first dispatch and forwards args, context and result", async () => {
    const def = (await register()).get("terminal.kill")!();

    const args = { terminalId: "t1" };

    await expect(def.run(args, ctx)).resolves.toEqual({ killed: true });
    await def.run(args, ctx);

    expect(m.implLoads).toBe(1);
    expect(m.runLookups).toBe(2);
    expect(m.kill).toHaveBeenCalledTimes(2);
    // Nothing is focused in this view, so the dispatch-time fallback is null.
    expect(m.kill).toHaveBeenCalledWith(args, ctx, null);
  });

  // Their targets are read at the keystroke, so they must not wait on a load.
  it("runs terminal.close and terminal.closeAll without loading the run bodies", async () => {
    const callbacks: ActionCallbacks = Object.assign(Object.create(null), {
      getActiveWorktreeId: () => null,
    });
    const actions = await register(callbacks);

    await expect(actions.get("terminal.closeAll")!().run(undefined, ctx)).resolves.toEqual({
      closedIds: [],
    });
    await expect(
      actions.get("terminal.close")!().run({ terminalId: "missing" }, ctx)
    ).rejects.toThrow();
    expect(m.implLoads).toBe(0);
  });

  it("rejects inside run when the run bodies fail to load", async () => {
    // Vitest wraps the factory's throw in its own message; the rejection is the point.
    m.failImpl = true;
    const def = (await register()).get("terminal.kill")!();
    await expect(def.run({ terminalId: "t1" }, ctx)).rejects.toThrow();
    expect(m.implLoads).toBe(1);
    expect(m.kill).not.toHaveBeenCalled();
  });
});

// A view's first dispatch waits on the chunk load. Focus that moves during it
// must not redirect a keybound kill or restart: both are read at the keystroke.
describe("terminal lifecycle focus fallback across the first load (#14273)", () => {
  const focus = { id: "A" as string | null };
  const removePanel = vi.fn();
  const restartTerminal = vi.fn();
  let releaseImpl: () => void = () => {};

  beforeEach(() => {
    vi.resetModules();
    focus.id = "A";
    removePanel.mockReset();
    restartTerminal.mockReset();
    const implGate = new Promise<void>((resolve) => {
      releaseImpl = resolve;
    });
    vi.doMock("@/store/panelStore", () => ({
      usePanelStore: {
        getState: () => ({
          focusedId: focus.id,
          panelsById: {
            A: { id: "A", kind: "terminal", location: "grid" },
            B: { id: "B", kind: "terminal", location: "grid" },
          },
          removePanel,
          restartTerminal,
        }),
      },
    }));
    vi.doMock("../terminalLifecycleActions.impl", async () => {
      await implGate;
      return vi.importActual("../terminalLifecycleActions.impl");
    });
  });

  afterEach(() => {
    vi.doUnmock("@/store/panelStore");
    vi.doUnmock("../terminalLifecycleActions.impl");
  });

  const keybinding: ActionContext = { dispatchSource: "keybinding" };

  it.each([
    ["terminal.kill", removePanel],
    ["terminal.restart", restartTerminal],
  ] as const)("%s targets the terminal focused at dispatch", async (id, effect) => {
    const def = (await register()).get(id)!();

    const result = def.run({}, keybinding);
    focus.id = "B";
    releaseImpl();
    await result;

    expect(effect).toHaveBeenCalledTimes(1);
    expect(effect).toHaveBeenCalledWith("A");
  });
});
