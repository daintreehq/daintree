import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";

const m = vi.hoisted(() => ({
  runLookups: 0,
  failImpl: false,
  push: vi.fn(),
}));

// A getter, so each test sees its own failure mode and lookup count however
// vitest caches the mocked module.
vi.mock("../gitActions.impl", () => ({
  get gitActionRuns() {
    m.runLookups++;
    if (m.failImpl) throw new Error("chunk load failed");
    return { "git.push": m.push };
  },
}));

const noCallbacks: ActionCallbacks = Object.create(null);
const ctx: ActionContext = { dispatchSource: "agent" };

async function register(): Promise<ActionRegistry> {
  const { registerGitActions } = await import("../gitActions");
  const actions: ActionRegistry = new Map();
  registerGitActions(actions, noCallbacks);
  return actions;
}

describe("git action run bodies (#14239)", () => {
  beforeEach(() => {
    vi.resetModules();
    m.runLookups = 0;
    m.failImpl = false;
    m.push.mockReset().mockResolvedValue({ pushed: true });
  });

  it("registers and materializes every definition without touching the run bodies", async () => {
    const actions = await register();
    for (const create of actions.values()) create();
    expect(actions.size).toBeGreaterThan(0);
    expect(m.runLookups).toBe(0);
  });

  it("loads the run bodies on first dispatch and forwards args, context and result", async () => {
    const def = (await register()).get("git.push")!();
    const args = { cwd: "/repo/one" };

    await expect(def.run(args, ctx)).resolves.toEqual({ pushed: true });
    await def.run(args, ctx);

    expect(m.runLookups).toBe(2);
    expect(m.push).toHaveBeenCalledTimes(2);
    expect(m.push).toHaveBeenCalledWith(args, ctx);
  });

  it("rejects inside run when the run bodies fail to load", async () => {
    m.failImpl = true;
    const def = (await register()).get("git.push")!();
    await expect(def.run({ cwd: "/repo/one" }, ctx)).rejects.toThrow("chunk load failed");
    expect(m.push).not.toHaveBeenCalled();
  });
});
