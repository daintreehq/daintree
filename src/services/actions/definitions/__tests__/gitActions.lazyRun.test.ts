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

  // These stand the palette's and the HUD's generic toast down (#16667), so a
  // load failure their own catch never saw must still be told. Enumerated from
  // the live definitions, so a newly flagged action is held to it too.
  async function selfReporting(): Promise<string[]> {
    const actions = await register();
    return [...actions.values()]
      .map((create) => create())
      .filter((def) => def.selfNotifiesOnExecutionError === true)
      .map((def) => def.id);
  }

  it("reports a failed load for every action that owns its failure toast", async () => {
    const ids = await selfReporting();
    expect(ids).toEqual(
      expect.arrayContaining(["git.push", "git.pullRebase", "git.forcePushWithLease"])
    );
    m.failImpl = true;
    const actions = await register();
    for (const id of ids) {
      notify.mockReset();
      const before = m.runLookups;
      await expect(
        actions.get(id as never)!().run({ cwd: "/repo/one" }, { dispatchSource: "keybinding" })
      ).rejects.toThrow("chunk load failed");
      // It got as far as the run bodies, so the throw is the load failure.
      expect(m.runLookups, id).toBe(before + 1);
      expect(notify, id).toHaveBeenCalledTimes(1);
      const toast = notify.mock.calls[0]![0] as { type: string; title: string; message: string };
      expect(toast.type).toBe("error");
      expect(toast.title.length, id).toBeGreaterThan(0);
      // Not the import's own message, which is a bundle path.
      expect(toast.message).not.toContain("chunk load failed");
    }
  });

  it("keeps a failed load quiet for an agent and for a caller that reports it", async () => {
    m.failImpl = true;
    const def = (await register()).get("git.push")!();
    await expect(def.run({ cwd: "/repo/one" }, ctx)).rejects.toThrow("chunk load failed");
    await expect(
      def.run({ cwd: "/repo/one" }, { dispatchSource: "user", callerReportsFailure: true })
    ).rejects.toThrow("chunk load failed");
    expect(m.runLookups).toBe(2);
    expect(notify).not.toHaveBeenCalled();
  });

  it("leaves a failed load to the palette for an action that does not own its toast", async () => {
    m.failImpl = true;
    const def = (await register()).get("git.stageAll")!();
    expect(def.selfNotifiesOnExecutionError).not.toBe(true);
    await expect(def.run({ cwd: "/repo/one" }, { dispatchSource: "user" })).rejects.toThrow(
      "chunk load failed"
    );
    expect(m.runLookups).toBe(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("reports a chunk that never loads, not only a module that loads broken", async () => {
    // The getter above throws after the import resolved. This rejects the
    // import itself, which is what a missing or poisoned chunk does.
    vi.doMock("../gitActions.impl", () => {
      throw new Error("Failed to fetch dynamically imported module");
    });
    try {
      const def = (await register()).get("git.push")!();
      await expect(
        def.run({ cwd: "/repo/one" }, { dispatchSource: "keybinding" })
      ).rejects.toThrow();
      expect(notify).toHaveBeenCalledTimes(1);
      expect((notify.mock.calls[0]![0] as { message: string }).message).not.toContain(
        "dynamically imported"
      );
    } finally {
      vi.doUnmock("../gitActions.impl");
    }
  });
});
