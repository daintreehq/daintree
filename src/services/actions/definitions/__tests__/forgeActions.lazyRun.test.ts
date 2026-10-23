import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";

const m = vi.hoisted(() => ({
  runLookups: 0,
  failImpl: false,
  getIssue: vi.fn(),
}));

// A getter, so each test sees its own failure mode and lookup count however
// vitest caches the mocked module.
vi.mock("../forgeActions.impl", () => ({
  get forgeActionRuns() {
    m.runLookups++;
    if (m.failImpl) throw new Error("chunk load failed");
    return { "forge.getIssue": m.getIssue };
  },
}));

const noCallbacks: ActionCallbacks = Object.create(null);
const ctx: ActionContext = { dispatchSource: "agent" };

async function register(): Promise<ActionRegistry> {
  const { registerForgeActions } = await import("../forgeActions");
  const actions: ActionRegistry = new Map();
  registerForgeActions(actions, noCallbacks);
  return actions;
}

describe("forge action run bodies (#14270)", () => {
  beforeEach(() => {
    vi.resetModules();
    m.runLookups = 0;
    m.failImpl = false;
    m.getIssue.mockReset().mockResolvedValue({ number: 42 });
  });

  it("registers and materializes every definition without touching the run bodies", async () => {
    const actions = await register();
    for (const create of actions.values()) create();
    expect(actions.size).toBeGreaterThan(0);
    expect(m.runLookups).toBe(0);
  });

  it("loads the run bodies on first dispatch and forwards args, context and result", async () => {
    const def = (await register()).get("forge.getIssue")!();
    const args = { issueNumber: 42, cwd: "/repo/one" };

    await expect(def.run(args, ctx)).resolves.toEqual({ number: 42 });
    await def.run(args, ctx);

    expect(m.runLookups).toBe(2);
    expect(m.getIssue).toHaveBeenCalledTimes(2);
    expect(m.getIssue).toHaveBeenCalledWith(args, ctx);
  });

  it("rejects inside run when the run bodies fail to load", async () => {
    m.failImpl = true;
    const def = (await register()).get("forge.getIssue")!();
    await expect(def.run({ issueNumber: 42, cwd: "/repo/one" }, ctx)).rejects.toThrow(
      "chunk load failed"
    );
    expect(m.getIssue).not.toHaveBeenCalled();
  });
});
