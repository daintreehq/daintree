import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  opId: undefined as string | undefined,
  runHostOperation: vi.fn(),
}));

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/clients/operationsClient", () => ({ mintRemoteOperationId: () => m.opId }));
vi.mock("@/hooks/useHostConnection", () => ({ runHostOperation: m.runHostOperation }));

import type { ActionContext } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import { registerGitActions } from "../gitActions";

// git.push uses no callbacks.
const noCallbacks: ActionCallbacks = Object.create(null);

function runPush() {
  const actions: ActionRegistry = new Map();
  registerGitActions(actions, noCallbacks);
  const def: AnyActionDefinition = actions.get("git.push")!();
  // Agent dispatch skips the renderer confirm dialog, which has no host here.
  const ctx: ActionContext = { dispatchSource: "agent" };
  return def.run({ cwd: "/repo/one" }, ctx);
}

let push: ReturnType<typeof vi.fn>;

beforeEach(() => {
  push = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(globalThis, "window", {
    value: { electron: { git: { push } } },
    configurable: true,
    writable: true,
  });
  m.runHostOperation.mockReset().mockImplementation((_opId, run: () => Promise<unknown>) => run());
});

afterEach(() => {
  Object.defineProperty(globalThis, "window", { value: undefined, configurable: true });
  m.opId = undefined;
});

describe("git.push as a host operation", () => {
  it("names the operation for a remote-bound view so a lost answer settles on the host's outcome", async () => {
    m.opId = "op-1";
    await runPush();
    expect(m.runHostOperation).toHaveBeenCalledWith("op-1", expect.any(Function), {
      fromResult: expect.any(Function),
    });
    expect(push).toHaveBeenCalledWith("/repo/one", undefined, "op-1");
  });

  it("pushes exactly as before in a local view", async () => {
    await runPush();
    expect(m.runHostOperation.mock.calls[0]![0]).toBeUndefined();
    expect(push).toHaveBeenCalledWith("/repo/one", undefined);
  });

  it("resolves a push the host recorded as succeeded", async () => {
    m.opId = "op-1";
    m.runHostOperation.mockImplementation(
      async (_opId, _run, options: { fromResult: (r: unknown) => unknown }) =>
        options.fromResult(null)
    );
    await expect(runPush()).resolves.toBeUndefined();
  });
});
