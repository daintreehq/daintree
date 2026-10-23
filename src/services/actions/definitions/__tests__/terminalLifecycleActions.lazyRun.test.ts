import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";

const m = vi.hoisted(() => ({
  runLookups: 0,
  failImpl: false,
  closeAll: vi.fn(),
}));

// A getter, so each test sees its own failure mode and lookup count however
// vitest caches the mocked module.
vi.mock("../terminalLifecycleActions.impl", () => ({
  get terminalLifecycleActionRuns() {
    m.runLookups++;
    if (m.failImpl) throw new Error("chunk load failed");
    return { "terminal.closeAll": m.closeAll };
  },
}));

const callbacks = { getActiveWorktreeId: () => "wt-1" } as unknown as ActionCallbacks;
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
    m.runLookups = 0;
    m.failImpl = false;
    m.closeAll.mockReset().mockResolvedValue({ closedIds: ["a"] });
  });

  it("registers and materializes every definition without touching the run bodies", async () => {
    const actions = await register();
    for (const create of actions.values()) create();
    expect(actions.size).toBeGreaterThan(0);
    expect(m.runLookups).toBe(0);
  });

  it("loads the run bodies on first dispatch and forwards args, context, callbacks and result", async () => {
    const def = (await register()).get("terminal.closeAll")!();

    await expect(def.run(undefined, ctx)).resolves.toEqual({ closedIds: ["a"] });
    await def.run(undefined, ctx);

    expect(m.runLookups).toBe(2);
    expect(m.closeAll).toHaveBeenCalledTimes(2);
    expect(m.closeAll).toHaveBeenCalledWith(undefined, ctx, callbacks);
  });

  it("rejects inside run when the run bodies fail to load", async () => {
    m.failImpl = true;
    const def = (await register()).get("terminal.closeAll")!();
    await expect(def.run(undefined, ctx)).rejects.toThrow("chunk load failed");
    expect(m.closeAll).not.toHaveBeenCalled();
  });
});
