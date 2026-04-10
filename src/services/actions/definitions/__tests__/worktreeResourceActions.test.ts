import { describe, it, expect, vi, beforeAll } from "vitest";
import type { ActionDefinition } from "@shared/types/actions";

// Stub all external imports that worktreeActions.ts pulls in
vi.mock("@/clients", () => ({
  copyTreeClient: {},
  githubClient: {},
  systemClient: {},
  worktreeClient: { resourceAction: vi.fn() },
}));

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({ getState: () => ({ worktrees: new Map() }) }),
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: () => ({}) },
}));

vi.mock("@/lib/copyTreeFormat", () => ({
  DEFAULT_COPYTREE_FORMAT: "text",
}));

vi.mock("@/store/terminalStore", () => ({
  useTerminalStore: { getState: () => ({ addTerminal: vi.fn() }) },
}));

type ActionFactory = () => ActionDefinition;

const RESOURCE_ACTION_IDS = [
  "worktree.resource.provision",
  "worktree.resource.teardown",
  "worktree.resource.resume",
  "worktree.resource.pause",
  "worktree.resource.status",
  "worktree.resource.connect",
] as const;

describe("worktree resource action definitions", () => {
  const registry = new Map<string, ActionFactory>();

  beforeAll(async () => {
    const { registerWorktreeActions } = await import("../worktreeActions");
    const callbacks = {
      getWorktrees: vi.fn(),
      onOpenSettings: vi.fn(),
      onCreateWorktree: vi.fn(),
      onDeleteWorktree: vi.fn(),
      onSwitchWorktree: vi.fn(),
    };
    registerWorktreeActions(registry as never, callbacks as never);
  });

  it("registers all 6 resource action IDs", () => {
    for (const id of RESOURCE_ACTION_IDS) {
      expect(registry.has(id), `missing action: ${id}`).toBe(true);
    }
  });

  it.each([
    ["worktree.resource.provision", "confirm"],
    ["worktree.resource.teardown", "confirm"],
    ["worktree.resource.resume", "safe"],
    ["worktree.resource.pause", "confirm"],
    ["worktree.resource.status", "safe"],
    ["worktree.resource.connect", "safe"],
  ] as const)("%s has danger=%s", (id, expectedDanger) => {
    const factory = registry.get(id)!;
    const def = factory();
    expect(def.danger).toBe(expectedDanger);
  });

  it("all resource actions have category=worktree and kind=command", () => {
    for (const id of RESOURCE_ACTION_IDS) {
      const def = registry.get(id)!();
      expect(def.category).toBe("worktree");
      expect(def.kind).toBe("command");
      expect(def.scope).toBe("renderer");
    }
  });

  it("connect action is enabled only when resourceConnectCommand exists", () => {
    const def = registry.get("worktree.resource.connect")!();
    // No worktree in the mocked store → isEnabled should return false
    expect(def.isEnabled!({ activeWorktreeId: "/test" })).toBe(false);
  });

  it("provision/teardown/resume/pause/status are enabled only when hasResourceConfig", () => {
    const nonConnectIds = RESOURCE_ACTION_IDS.filter((id) => id !== "worktree.resource.connect");
    for (const id of nonConnectIds) {
      const def = registry.get(id)!();
      // No worktree in the mocked store → isEnabled should return false
      expect(def.isEnabled!({ activeWorktreeId: "/test" }), `${id} should be disabled`).toBe(false);
    }
  });
});
