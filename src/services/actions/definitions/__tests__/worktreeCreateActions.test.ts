import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const worktreeClientMock = vi.hoisted(() => ({
  create: vi.fn(),
  delete: vi.fn().mockResolvedValue(undefined),
  getAll: vi.fn().mockResolvedValue([]),
}));

const selectionStoreMock = vi.hoisted(() => ({
  openQuickCreate: vi.fn(),
  openCreateDialog: vi.fn(),
}));

let panelState: {
  panelIds: string[];
  panelsById: Record<
    string,
    { worktreeId?: string; location?: string; excludeFromPersistence?: boolean }
  >;
  removePanel: ReturnType<typeof vi.fn>;
};
const originalWindow = globalThis.window;

vi.mock("@/clients", () => ({
  worktreeClient: worktreeClientMock,
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => panelState,
  },
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: {
    getState: () => selectionStoreMock,
  },
}));

import { registerWorktreeCreateActions } from "../worktreeCreateActions";
import { PartialSuccessError, parsePartialSuccessMessage } from "@shared/utils/partialSuccess";

function setupActions() {
  const actions: ActionRegistry = new Map();
  registerWorktreeCreateActions(actions, {} as ActionCallbacks);

  return async (id: string, args?: unknown): Promise<unknown> => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing action: ${id}`);
    const def = factory() as AnyActionDefinition;
    return def.run(args, {} as never);
  };
}

function installTerminalInfoMock(getInfo: ReturnType<typeof vi.fn>) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      electron: {
        terminal: { getInfo },
        devPreview: {
          getByWorktree: vi.fn().mockResolvedValue(null),
          stopByWorktree: vi.fn().mockResolvedValue(undefined),
        },
      },
    },
  });
}

describe("worktree.delete action", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    worktreeClientMock.delete.mockResolvedValue(undefined);
    worktreeClientMock.getAll.mockResolvedValue([]);
    panelState = {
      panelIds: ["terminal-1"],
      panelsById: {
        "terminal-1": {
          worktreeId: "wt-1",
          location: "grid",
          excludeFromPersistence: false,
        },
      },
      removePanel: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });

  it("waits for closed terminals to disappear from the backend before deleting", async () => {
    const getInfo = vi.fn().mockResolvedValue({ hasPty: false });
    installTerminalInfoMock(getInfo);

    const run = setupActions();
    const promise = run("worktree.delete", { worktreeId: "wt-1", closeTerminals: true });

    await vi.advanceTimersByTimeAsync(500);

    expect(panelState.removePanel).toHaveBeenCalledWith("terminal-1");
    expect(worktreeClientMock.delete).not.toHaveBeenCalled();

    getInfo.mockRejectedValue(new Error("Terminal terminal-1 not found"));

    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(worktreeClientMock.delete).toHaveBeenCalledWith("wt-1", {
      force: undefined,
      deleteBranch: undefined,
    });
  });

  it("reports a kept branch as a partial success, not a retryable failure", async () => {
    // The branch step runs after `git worktree remove` has already succeeded,
    // and the branch was retained on purpose. Rethrowing it plain lands as a
    // retryable EXECUTION_ERROR, which tells an agent to retry the one thing
    // that cannot work — the worktree it names is gone.
    installTerminalInfoMock(vi.fn().mockResolvedValue({ hasPty: false }));
    worktreeClientMock.delete.mockRejectedValue(
      new Error(
        "Worktree deleted, but branch feature/x was kept because Git reports it isn't fully merged"
      )
    );

    const run = setupActions();
    const error = await run("worktree.delete", {
      worktreeId: "wt-1",
      deleteBranch: true,
    }).then(
      () => null,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(PartialSuccessError);
    // Narrow by guard rather than assertion — the class IS the provenance
    // `ActionService` keys `PARTIAL_SUCCESS` off, so the type matters here.
    if (!(error instanceof PartialSuccessError)) throw new Error("expected a partial success");
    expect(error.partialResult).toEqual({ worktreeDeleted: true, branchDeleted: false });
    // The ownership ledger attributes a half-CREATED worktree off `worktreeId`;
    // a delete's payload must never carry the field that mints ownership.
    expect(error.partialResult.worktreeId).toBeUndefined();
    const payload = parsePartialSuccessMessage(error.message);
    expect(payload?.message).toContain("was kept because Git reports it isn't fully merged");
  });

  it("still rethrows an ordinary delete failure unchanged", async () => {
    installTerminalInfoMock(vi.fn().mockResolvedValue({ hasPty: false }));
    const raw = new Error("Cannot delete active worktree");
    worktreeClientMock.delete.mockRejectedValue(raw);

    const run = setupActions();
    const error = await run("worktree.delete", { worktreeId: "wt-1" }).then(
      () => null,
      (e: unknown) => e
    );

    expect(error).toBe(raw);
  });
});
