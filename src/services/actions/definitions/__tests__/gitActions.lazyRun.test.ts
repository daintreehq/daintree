import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";

const m = vi.hoisted(() => ({
  runLookups: 0,
  failImpl: false,
  push: vi.fn(),
}));

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify }));

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
    notify.mockReset();
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

  // `git.push` stands the palette's and the HUD's generic toast down (#16667),
  // so a load failure it never reached its own catch for must still be told.
  it("reports a failed load for an action that owns its failure toast", async () => {
    m.failImpl = true;
    const def = (await register()).get("git.push")!();
    await expect(def.run({ cwd: "/repo/one" }, { dispatchSource: "keybinding" })).rejects.toThrow(
      "chunk load failed"
    );
    expect(notify).toHaveBeenCalledTimes(1);
    const toast = notify.mock.calls[0]![0] as { type: string; title: string; message: string };
    expect(toast.type).toBe("error");
    expect(toast.title).toBe("Push failed");
    // Not the import's own message, which is a bundle path.
    expect(toast.message).not.toContain("chunk load failed");
  });

  it("keeps a failed load quiet for an agent and for a caller that reports it", async () => {
    m.failImpl = true;
    const def = (await register()).get("git.push")!();
    await expect(def.run({ cwd: "/repo/one" }, ctx)).rejects.toThrow();
    await expect(
      def.run({ cwd: "/repo/one" }, { dispatchSource: "user", callerReportsFailure: true })
    ).rejects.toThrow();
    expect(notify).not.toHaveBeenCalled();
  });

  it("leaves a failed load to the palette for an action that does not own its toast", async () => {
    m.failImpl = true;
    const def = (await register()).get("git.stageAll")!();
    await expect(def.run({ cwd: "/repo/one" }, { dispatchSource: "user" })).rejects.toThrow();
    expect(notify).not.toHaveBeenCalled();
  });
});
