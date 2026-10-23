import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ActionRegistry } from "../../actionTypes";

const m = vi.hoisted(() => ({
  runLookups: 0,
  failImpl: false,
  kill: vi.fn(),
}));

// A getter, so each test sees its own failure mode and lookup count however
// vitest caches the mocked module.
vi.mock("../fleetActions.impl", () => ({
  get fleetActionRuns() {
    m.runLookups++;
    if (m.failImpl) throw new Error("chunk load failed");
    return { "fleet.kill": m.kill };
  },
}));

const ctx: ActionContext = { dispatchSource: "agent" };

async function register(): Promise<ActionRegistry> {
  const { registerFleetActions } = await import("../fleetActions");
  const actions: ActionRegistry = new Map();
  registerFleetActions(actions);
  return actions;
}

describe("fleet action run bodies (#14272)", () => {
  beforeEach(() => {
    vi.resetModules();
    m.runLookups = 0;
    m.failImpl = false;
    m.kill.mockReset().mockResolvedValue({ killed: 2 });
  });

  it("registers and materializes every definition without touching the run bodies", async () => {
    const actions = await register();
    for (const create of actions.values()) create();
    expect(actions.size).toBeGreaterThan(0);
    expect(m.runLookups).toBe(0);
  });

  it("loads the run bodies on first dispatch and forwards args, context and result", async () => {
    const def = (await register()).get("fleet.kill")!();
    const args = { confirmed: true };

    await expect(def.run(args, ctx)).resolves.toEqual({ killed: 2 });
    await def.run(args, ctx);

    expect(m.runLookups).toBe(2);
    expect(m.kill).toHaveBeenCalledTimes(2);
    expect(m.kill).toHaveBeenCalledWith(args, ctx);
  });

  it("rejects inside run when the run bodies fail to load", async () => {
    m.failImpl = true;
    const def = (await register()).get("fleet.kill")!();
    await expect(def.run({ confirmed: true }, ctx)).rejects.toThrow("chunk load failed");
    expect(m.kill).not.toHaveBeenCalled();
  });
});
