import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";

const m = vi.hoisted(() => ({
  implLoads: 0,
  runLookups: 0,
  failImpl: false,
  closeAll: vi.fn(),
}));

const callbacks: ActionCallbacks = Object.assign(Object.create(null), {
  getActiveWorktreeId: () => "wt-1",
});

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
        return { "terminal.closeAll": m.closeAll };
      },
    };
  });
}

const ctx: ActionContext = { dispatchSource: "agent" };

async function register(): Promise<ActionRegistry> {
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
    m.closeAll.mockReset().mockResolvedValue({ closedIds: ["a"] });
  });

  it("registers and materializes every definition without touching the run bodies", async () => {
    const actions = await register();
    for (const create of actions.values()) create();
    expect(actions.size).toBeGreaterThan(0);
    expect(m.implLoads).toBe(0);
    expect(m.runLookups).toBe(0);
  });

  it("loads the run bodies on first dispatch and forwards args, context, callbacks and result", async () => {
    const def = (await register()).get("terminal.closeAll")!();

    await expect(def.run(undefined, ctx)).resolves.toEqual({ closedIds: ["a"] });
    await def.run(undefined, ctx);

    expect(m.implLoads).toBe(1);
    expect(m.runLookups).toBe(2);
    expect(m.closeAll).toHaveBeenCalledTimes(2);
    expect(m.closeAll).toHaveBeenCalledWith(undefined, ctx, callbacks);
  });

  it("rejects inside run when the run bodies fail to load", async () => {
    // Vitest wraps the factory's throw in its own message; the rejection is the point.
    m.failImpl = true;
    const def = (await register()).get("terminal.closeAll")!();
    await expect(def.run(undefined, ctx)).rejects.toThrow();
    expect(m.implLoads).toBe(1);
    expect(m.closeAll).not.toHaveBeenCalled();
  });
});
