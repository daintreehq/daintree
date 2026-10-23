import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";

const m = vi.hoisted(() => ({
  runLookups: 0,
  failImpl: false,
  close: vi.fn(),
}));

// A getter, so each test sees its own failure mode and lookup count however
// vitest caches the mocked module.
vi.mock("../projectActions.impl", () => ({
  get projectActionRuns() {
    m.runLookups++;
    if (m.failImpl) throw new Error("chunk load failed");
    return { "project.close": m.close };
  },
}));

// Forwarded by identity, never called here.
const callbacks: ActionCallbacks = Object.create(null);
const ctx: ActionContext = { dispatchSource: "agent" };

async function register(): Promise<ActionRegistry> {
  const { registerProjectActions } = await import("../projectActions");
  const actions: ActionRegistry = new Map();
  registerProjectActions(actions, callbacks);
  return actions;
}

describe("project action run bodies (#14269)", () => {
  beforeEach(() => {
    vi.resetModules();
    m.runLookups = 0;
    m.failImpl = false;
    m.close.mockReset().mockResolvedValue({ closed: true });
  });

  it("registers and materializes every definition without touching the run bodies", async () => {
    const actions = await register();
    for (const create of actions.values()) create();
    expect(actions.size).toBeGreaterThan(0);
    expect(m.runLookups).toBe(0);
  });

  it("loads the run bodies on first dispatch and forwards args, context, callbacks and result", async () => {
    const def = (await register()).get("project.close")!();
    const args = { projectId: "proj-1" };

    await expect(def.run(args, ctx)).resolves.toEqual({ closed: true });
    await def.run(args, ctx);

    expect(m.runLookups).toBe(2);
    expect(m.close).toHaveBeenCalledTimes(2);
    expect(m.close).toHaveBeenCalledWith(args, ctx, callbacks);
    expect(m.close.mock.calls[0]?.[2]).toBe(callbacks);
  });

  it("forwards each registration's own callbacks", async () => {
    const { registerProjectActions } = await import("../projectActions");
    const other: ActionCallbacks = Object.create(null);
    const first: ActionRegistry = new Map();
    const second: ActionRegistry = new Map();
    registerProjectActions(first, callbacks);
    registerProjectActions(second, other);

    await first.get("project.close")!().run({ projectId: "a" }, ctx);
    await second.get("project.close")!().run({ projectId: "b" }, ctx);

    expect(m.close.mock.calls[0]?.[2]).toBe(callbacks);
    expect(m.close.mock.calls[1]?.[2]).toBe(other);
  });

  it("rejects inside run when the run bodies fail to load", async () => {
    m.failImpl = true;
    const def = (await register()).get("project.close")!();
    await expect(def.run({ projectId: "proj-1" }, ctx)).rejects.toThrow("chunk load failed");
    expect(m.close).not.toHaveBeenCalled();
  });
});
