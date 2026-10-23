import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";

const m = vi.hoisted(() => ({
  runLookups: 0,
  failImpl: false,
  shortcuts: vi.fn(),
  launchAgent: vi.fn(),
  snapshot: { context: { focusedWorktreeId: "wt-at-dispatch" }, workspace: null },
}));

// A getter, so each test sees its own failure mode and lookup count however
// vitest caches the mocked module.
vi.mock("../helpActions.impl", () => ({
  get helpActionRuns() {
    m.runLookups++;
    if (m.failImpl) throw new Error("chunk load failed");
    return { "help.shortcuts": m.shortcuts, "help.launchAgent": m.launchAgent };
  },
}));

vi.mock("../helpLaunchSnapshot", () => ({
  captureHelpLaunchSnapshot: () => m.snapshot,
}));

const callbacks: ActionCallbacks = Object.create(null);
const ctx: ActionContext = { dispatchSource: "agent" };

async function register(): Promise<ActionRegistry> {
  const { registerHelpActions } = await import("../helpActions");
  const actions: ActionRegistry = new Map();
  registerHelpActions(actions, callbacks);
  return actions;
}

describe("help action run bodies (#14271)", () => {
  beforeEach(() => {
    vi.resetModules();
    m.runLookups = 0;
    m.failImpl = false;
    m.shortcuts.mockReset().mockResolvedValue("opened");
    m.launchAgent.mockReset().mockResolvedValue({ slot: 0 });
  });

  it("registers and materializes every definition without touching the run bodies", async () => {
    const actions = await register();
    for (const create of actions.values()) create();
    expect(actions.size).toBeGreaterThan(0);
    expect(m.runLookups).toBe(0);
  });

  it("loads the run bodies on first dispatch and forwards args, context, callbacks and result", async () => {
    const def = (await register()).get("help.shortcuts")!();
    const args = { probe: true };

    await expect(def.run(args, ctx)).resolves.toBe("opened");
    await def.run(args, ctx);

    expect(m.runLookups).toBe(2);
    expect(m.shortcuts).toHaveBeenCalledTimes(2);
    expect(m.shortcuts).toHaveBeenCalledWith(args, ctx, callbacks, undefined);
  });

  it("hands help.launchAgent the snapshot taken at dispatch, before the chunk loads", async () => {
    const def = (await register()).get("help.launchAgent")!();
    const pending = def.run({ agentId: "claude" }, ctx);
    m.snapshot = { context: { focusedWorktreeId: "wt-drifted" }, workspace: null };

    await expect(pending).resolves.toEqual({ slot: 0 });
    expect(m.launchAgent).toHaveBeenCalledWith({ agentId: "claude" }, ctx, callbacks, {
      context: { focusedWorktreeId: "wt-at-dispatch" },
      workspace: null,
    });
  });

  it("rejects inside run when the run bodies fail to load", async () => {
    m.failImpl = true;
    const def = (await register()).get("help.shortcuts")!();
    await expect(def.run(undefined, ctx)).rejects.toThrow("chunk load failed");
    expect(m.shortcuts).not.toHaveBeenCalled();
  });
});
