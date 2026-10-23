import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";

const m = vi.hoisted(() => ({
  runLookups: 0,
  failImpl: false,
  checkCommand: vi.fn(),
}));

// A getter, so each test sees its own failure mode and lookup count however
// vitest caches the mocked module.
vi.mock("../systemActions.impl", () => ({
  get systemActionRuns() {
    m.runLookups++;
    if (m.failImpl) throw new Error("chunk load failed");
    return { "system.checkCommand": m.checkCommand };
  },
}));

const noCallbacks: ActionCallbacks = Object.create(null);
const ctx: ActionContext = { dispatchSource: "agent" };

async function register(): Promise<ActionRegistry> {
  const { registerSystemActions } = await import("../systemActions");
  const actions: ActionRegistry = new Map();
  registerSystemActions(actions, noCallbacks);
  return actions;
}

describe("system action run bodies (#14274)", () => {
  beforeEach(() => {
    vi.resetModules();
    m.runLookups = 0;
    m.failImpl = false;
    m.checkCommand.mockReset().mockResolvedValue({ available: true });
  });

  it("registers and materializes every definition without touching the run bodies", async () => {
    const actions = await register();
    for (const create of actions.values()) create();
    expect(actions.size).toBeGreaterThan(0);
    expect(m.runLookups).toBe(0);
  });

  it("loads the run bodies on first dispatch and forwards args, context and result", async () => {
    const def = (await register()).get("system.checkCommand")!();
    const args = { command: "node" };

    await expect(def.run(args, ctx)).resolves.toEqual({ available: true });
    await def.run(args, ctx);

    expect(m.runLookups).toBe(2);
    expect(m.checkCommand).toHaveBeenCalledTimes(2);
    expect(m.checkCommand).toHaveBeenCalledWith(args, ctx);
  });

  it("rejects inside run when the run bodies fail to load", async () => {
    m.failImpl = true;
    const def = (await register()).get("system.checkCommand")!();
    await expect(def.run({ command: "node" }, ctx)).rejects.toThrow("chunk load failed");
    expect(m.checkCommand).not.toHaveBeenCalled();
  });
});
