import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const worktreeClientMock = vi.hoisted(() => ({
  create: vi.fn(),
  delete: vi.fn().mockResolvedValue(undefined),
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
});
