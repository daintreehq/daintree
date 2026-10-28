import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";

const m = vi.hoisted(() => ({
  implEvaluations: 0,
  runLookups: 0,
  failImpl: false,
  inject: vi.fn(),
}));

// The factory counts evaluations, so an eager import of the run bodies shows
// up at registration; the getter counts lookups and fails like a chunk load
// would, however vitest caches the mocked module.
vi.mock("../worktreeContextActions.impl", () => {
  m.implEvaluations++;
  return {
    get worktreeContextActionRuns() {
      m.runLookups++;
      if (m.failImpl) throw new Error("chunk load failed");
      return { "worktree.inject": m.inject };
    },
  };
});

// Identity is what's asserted: the run must receive the registrar's own
// callbacks, not a copy or a stand-in.
const callbacks: ActionCallbacks = Object.create(null);
const ctx: ActionContext = { dispatchSource: "agent", focusedTerminalId: "term-1" };

async function register(): Promise<ActionRegistry> {
  const { registerWorktreeContextActions } = await import("../worktreeContextActions");
  const actions: ActionRegistry = new Map();
  registerWorktreeContextActions(actions, callbacks);
  return actions;
}

describe("worktree context action run bodies (#14274)", () => {
  beforeEach(() => {
    vi.resetModules();
    m.runLookups = 0;
    m.failImpl = false;
    m.inject.mockReset().mockResolvedValue({ injected: true });
  });

  it("registers and materializes every definition without touching the run bodies", async () => {
    const evaluationsBefore = m.implEvaluations;
    const actions = await register();
    for (const create of actions.values()) create();
    expect(actions.size).toBeGreaterThan(0);
    expect(m.implEvaluations).toBe(evaluationsBefore);
    expect(m.runLookups).toBe(0);
  });

  it("loads the run bodies on first dispatch and forwards args, context, callbacks and result", async () => {
    const def = (await register()).get("worktree.inject")!();
    const args = { worktreeId: "wt-1" };

    await expect(def.run(args, ctx)).resolves.toEqual({ injected: true });
    expect(m.runLookups).toBe(1);
    const [forwardedArgs, forwardedCtx, forwardedCallbacks] = m.inject.mock.calls[0]!;
    expect(forwardedArgs).toBe(args);
    expect(forwardedCtx).toBe(ctx);
    expect(forwardedCallbacks).toBe(callbacks);

    await def.run(args, ctx);
    expect(m.runLookups).toBe(2);
    expect(m.inject).toHaveBeenCalledTimes(2);
  });

  it("rejects inside run when the run bodies fail to load", async () => {
    m.failImpl = true;
    const actions = await register();
    for (const create of actions.values()) create();
    const def = actions.get("worktree.inject")!();
    await expect(def.run({ worktreeId: "wt-1" }, ctx)).rejects.toThrow("chunk load failed");
    expect(m.inject).not.toHaveBeenCalled();
  });
});
