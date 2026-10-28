import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";

const m = vi.hoisted(() => ({
  runLookups: 0,
  failImpl: false,
  startWork: vi.fn(),
  runs: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

// A getter, so each test sees its own failure mode and lookup count however
// vitest caches the mocked module.
vi.mock("../workflowCreationActions.impl", () => ({
  get workflowCreationActionRuns() {
    m.runLookups++;
    if (m.failImpl) throw new Error("chunk load failed");
    return { ...m.runs, "workflow.startWorkOnIssue": m.startWork };
  },
}));

type WorkflowCallbacks = Pick<ActionCallbacks, "onLaunchAgent">;

function makeCallbacks(): WorkflowCallbacks {
  return { onLaunchAgent: vi.fn() };
}

const callbacks = makeCallbacks();
const ctx: ActionContext = { dispatchSource: "agent" };
const args = { issueNumber: 7, agentId: "claude" };

async function register(withCallbacks: WorkflowCallbacks = callbacks): Promise<ActionRegistry> {
  const { registerWorkflowCreationActions } = await import("../workflowCreationActions");
  const actions: ActionRegistry = new Map();
  registerWorkflowCreationActions(actions, withCallbacks);
  return actions;
}

describe("workflow-creation action run bodies (#14275)", () => {
  beforeEach(() => {
    vi.resetModules();
    m.runLookups = 0;
    m.failImpl = false;
    m.startWork.mockReset().mockResolvedValue({ worktreeId: "wt-1" });
    m.runs = {};
  });

  it("registers and materializes every definition without touching the run bodies", async () => {
    const actions = await register();
    for (const create of actions.values()) create();
    expect(actions.size).toBeGreaterThan(0);
    expect(m.runLookups).toBe(0);
  });

  it("loads the run bodies on first dispatch and forwards args, context, callbacks and result", async () => {
    const def = (await register()).get("workflow.startWorkOnIssue")!();
    const result = { worktreeId: "wt-1" };
    m.startWork.mockResolvedValue(result);

    await expect(def.run(args, ctx)).resolves.toBe(result);
    await def.run(args, ctx);

    expect(m.runLookups).toBe(2);
    expect(m.startWork).toHaveBeenCalledTimes(2);
    expect(m.startWork.mock.calls[0]?.[0]).toBe(args);
    expect(m.startWork.mock.calls[0]?.[1]).toBe(ctx);
    expect(m.startWork.mock.calls[0]?.[2]).toBe(callbacks);
  });

  it("lets the run body reach the registrar's onLaunchAgent", async () => {
    const own = makeCallbacks();
    vi.mocked(own.onLaunchAgent).mockResolvedValue(null);
    m.startWork.mockImplementation((_args: unknown, _ctx: ActionContext, cb: WorkflowCallbacks) =>
      cb.onLaunchAgent("claude", {})
    );
    const def = (await register(own)).get("workflow.startWorkOnIssue")!();

    await expect(def.run(args, ctx)).resolves.toBeNull();
    expect(own.onLaunchAgent).toHaveBeenCalledWith("claude", {});
    expect(callbacks.onLaunchAgent).not.toHaveBeenCalled();
  });

  it("hands every definition's dispatch to its own run body", async () => {
    const actions = await register();
    for (const id of actions.keys()) {
      m.runs[id] = vi.fn().mockResolvedValue({ ran: id });
    }
    m.startWork.mockResolvedValue({ ran: "workflow.startWorkOnIssue" });

    for (const [id, create] of actions) {
      await expect(create().run(args, ctx)).resolves.toEqual({ ran: id });
    }
    expect(actions.size).toBe(2);
    expect(m.runs["worktree.createWithRecipe"]).toHaveBeenCalledWith(args, ctx, callbacks);
  });

  it("keeps each registry's callbacks apart", async () => {
    const first = makeCallbacks();
    const second = makeCallbacks();
    const { registerWorkflowCreationActions } = await import("../workflowCreationActions");
    const a: ActionRegistry = new Map();
    const b: ActionRegistry = new Map();
    registerWorkflowCreationActions(a, first);
    registerWorkflowCreationActions(b, second);

    await a.get("workflow.startWorkOnIssue")!().run(args, ctx);
    await b.get("workflow.startWorkOnIssue")!().run(args, ctx);

    expect(m.startWork.mock.calls[0]?.[2]).toBe(first);
    expect(m.startWork.mock.calls[1]?.[2]).toBe(second);
  });

  it("rejects inside run when the run bodies fail to load", async () => {
    m.failImpl = true;
    const def = (await register()).get("workflow.startWorkOnIssue")!();
    await expect(def.run(args, ctx)).rejects.toThrow("chunk load failed");
    expect(m.startWork).not.toHaveBeenCalled();
  });
});
