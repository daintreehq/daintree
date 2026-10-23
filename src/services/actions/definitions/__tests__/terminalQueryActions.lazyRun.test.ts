import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";

const m = vi.hoisted(() => ({
  runLookups: 0,
  failImpl: false,
  getStatus: vi.fn(),
}));

// A getter, so each test sees its own failure mode and lookup count however
// vitest caches the mocked module.
vi.mock("../terminalQueryActions.impl", () => ({
  get terminalQueryActionRuns() {
    m.runLookups++;
    if (m.failImpl) throw new Error("chunk load failed");
    return { "terminal.getStatus": m.getStatus };
  },
}));

const noCallbacks: ActionCallbacks = Object.create(null);
const ctx: ActionContext = { dispatchSource: "agent" };

async function register(): Promise<ActionRegistry> {
  const { registerTerminalQueryActions } = await import("../terminalQueryActions");
  const actions: ActionRegistry = new Map();
  registerTerminalQueryActions(actions, noCallbacks);
  return actions;
}

describe("terminal query action run bodies (#14273)", () => {
  beforeEach(() => {
    vi.resetModules();
    m.runLookups = 0;
    m.failImpl = false;
    m.getStatus.mockReset().mockResolvedValue({ terminals: [] });
  });

  it("registers and materializes every definition without touching the run bodies", async () => {
    const actions = await register();
    for (const create of actions.values()) create();
    expect(actions.size).toBeGreaterThan(0);
    expect(m.runLookups).toBe(0);
  });

  it("loads the run bodies on first dispatch and forwards args, context and result", async () => {
    const def = (await register()).get("terminal.getStatus")!();
    const args = { terminalIds: ["t1"] };

    await expect(def.run(args, ctx)).resolves.toEqual({ terminals: [] });
    await def.run(args, ctx);

    expect(m.runLookups).toBe(2);
    expect(m.getStatus).toHaveBeenCalledTimes(2);
    expect(m.getStatus).toHaveBeenCalledWith(args, ctx);
  });

  it("rejects inside run when the run bodies fail to load", async () => {
    m.failImpl = true;
    const def = (await register()).get("terminal.getStatus")!();
    await expect(def.run({ terminalIds: ["t1"] }, ctx)).rejects.toThrow("chunk load failed");
    expect(m.getStatus).not.toHaveBeenCalled();
  });
});
