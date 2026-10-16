import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { ActionId } from "@shared/types/actions";

const refreshMock = vi.hoisted(() => vi.fn<(worktreeId: string) => Promise<void>>());

vi.mock("@/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/clients")>()),
  worktreeClient: { refresh: refreshMock },
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import { registerGitActions } from "../gitActions";
import { registerFileActions } from "../fileActions";
import { useFileMutationConfirmStore } from "@/store/fileMutationConfirmStore";
import {
  resetStoreAccessorsForTesting,
  setWorktreePathIndexAccessor,
} from "@/store/storeAccessors";

const discardMock = vi.fn<(payload: unknown) => Promise<void>>();
const trashMock = vi.fn<(payload: unknown) => Promise<void>>();

function setup() {
  const actions: ActionRegistry = new Map();
  // Neither action reads a callback.
  const callbacks: ActionCallbacks = Object.create(null);
  registerGitActions(actions, callbacks);
  registerFileActions(actions, callbacks);
  Object.defineProperty(globalThis, "window", {
    value: { electron: { git: { discardFileChanges: discardMock }, files: { trash: trashMock } } },
    configurable: true,
    writable: true,
  });
  return (id: ActionId, args: unknown, ctx: Record<string, unknown> = {}) => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    const def: AnyActionDefinition = factory();
    return def.run(def.argsSchema ? def.argsSchema.parse(args) : args, ctx as never);
  };
}

async function answer(ok: boolean): Promise<void> {
  await vi.waitFor(() => {
    expect(useFileMutationConfirmStore.getState().pendingConfirm).not.toBeNull();
  });
  useFileMutationConfirmStore.getState().resolveConfirmation(ok);
}

const ARGS = { worktreePath: "/repo/one", filePath: "src/index.ts" };
const PAYLOAD = { worktreePath: "/repo/one", relativePath: "src/index.ts" };

beforeEach(() => {
  setWorktreePathIndexAccessor(() => new Map([["wt-1", "/repo/one"]]));
  discardMock.mockReset().mockResolvedValue(undefined);
  trashMock.mockReset().mockResolvedValue(undefined);
  refreshMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  resetStoreAccessorsForTesting();
  if (useFileMutationConfirmStore.getState().pendingConfirm) {
    useFileMutationConfirmStore.getState().resolveConfirmation(false);
  }
  Object.defineProperty(globalThis, "window", { value: undefined, configurable: true });
});

describe.each([
  ["git.discardFileChanges", "discard", discardMock],
  ["file.trash", "trash", trashMock],
] as const)("%s", (actionId, kind, ipc) => {
  it("asks first, naming the file, and only then calls IPC", async () => {
    const run = setup();
    const pending = run(actionId, ARGS, { dispatchSource: "context-menu" });

    await vi.waitFor(() => {
      expect(useFileMutationConfirmStore.getState().pendingConfirm).toMatchObject({
        kind,
        relativePath: "src/index.ts",
      });
    });
    expect(ipc).not.toHaveBeenCalled();

    await answer(true);
    await pending;
    expect(ipc).toHaveBeenCalledWith(PAYLOAD);
    expect(refreshMock).toHaveBeenCalledWith("wt-1");
  });

  it("does nothing when the confirm is declined", async () => {
    const run = setup();
    const pending = run(actionId, ARGS, { dispatchSource: "user" });

    await answer(false);
    await pending;
    expect(ipc).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("skips the renderer dialog for agent dispatch, which the MCP bridge already confirmed", async () => {
    const run = setup();
    const pending = run(actionId, ARGS, { dispatchSource: "agent" });

    expect(useFileMutationConfirmStore.getState().pendingConfirm).toBeNull();
    await pending;
    expect(ipc).toHaveBeenCalledWith(PAYLOAD);
  });

  it("surfaces an IPC failure to the caller", async () => {
    ipc.mockRejectedValue(new Error("No trash on this volume"));
    const run = setup();
    const pending = run(actionId, ARGS, { dispatchSource: "agent" });

    await expect(pending).rejects.toThrow("No trash on this volume");
  });
});
