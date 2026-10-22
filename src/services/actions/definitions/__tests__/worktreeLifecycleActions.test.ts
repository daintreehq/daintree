import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { ActionContext } from "@shared/types/actions";
import type { WorktreeLifecycleStatus, WorktreeSetupStatus } from "@shared/types/worktree";

const viewStoreMock = vi.hoisted(() => ({ getCurrentViewStore: vi.fn() }));

vi.mock("@/clients", () => ({ worktreeClient: { retrySetup: vi.fn() } }));
vi.mock("@/store/createWorktreeStore", () => viewStoreMock);
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import { registerWorktreeLifecycleActions } from "../worktreeLifecycleActions";

type Row = { lifecycleStatus?: WorktreeLifecycleStatus; setupStatus?: WorktreeSetupStatus };

function retrySetup(row: Row): AnyActionDefinition {
  viewStoreMock.getCurrentViewStore.mockReturnValue({
    getState: () => ({ worktrees: new Map([["wt-1", { id: "wt-1", ...row }]]) }),
  });
  const registry: ActionRegistry = new Map();
  registerWorktreeLifecycleActions(registry);
  const factory = registry.get("worktree.lifecycle.retrySetup");
  if (!factory) throw new Error("worktree.lifecycle.retrySetup not registered");
  return factory();
}

const ctx = { focusedWorktreeId: "wt-1" } as ActionContext;

describe("worktree.lifecycle.retrySetup availability (#13807)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("offers a retry for failed plugin steps after a resource action took the lifecycle slot", () => {
    const def = retrySetup({
      lifecycleStatus: { phase: "resource-status", state: "success", startedAt: 1 },
      setupStatus: {
        state: "failed",
        stage: "plugin-steps",
        startedAt: 1,
        error: 'Acme "Provision DB" failed: quota exceeded',
      },
    });
    expect(def.isEnabled?.(ctx)).toBe(true);
    expect(def.disabledReason?.(ctx)).toBeUndefined();
  });

  it("does not offer one for a submodule failure, which a retry would not rerun", () => {
    const def = retrySetup({
      setupStatus: { state: "failed", stage: "submodules", startedAt: 1, error: "no remote" },
    });
    expect(def.isEnabled?.(ctx)).toBe(false);
    expect(def.disabledReason?.(ctx)).toBe("No failed setup to retry");
  });

  it("refuses while plugin steps are still running", () => {
    const def = retrySetup({
      lifecycleStatus: { phase: "setup", state: "failed", startedAt: 1 },
      setupStatus: { state: "running", stage: "plugin-steps", startedAt: 1 },
    });
    expect(def.isEnabled?.(ctx)).toBe(false);
    expect(def.disabledReason?.(ctx)).toBe("Setup is already running");
  });
});
