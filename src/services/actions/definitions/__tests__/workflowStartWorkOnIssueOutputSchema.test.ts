// Introspecting a generated JSON Schema means narrowing `unknown` records at
// every step; same trade-off (and same waiver) as workflowActions.adversarial.
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
import { describe, expect, it, vi } from "vitest";
import type { ActionId } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

// ActionService pulls in the shortcut-hint store, keybinding service, and notify
// at module load / dispatch time. Registration only needs the module to import
// cleanly, so stub them out.
vi.mock("../../../../store/shortcutHintStore", () => ({
  shortcutHintStore: {
    getState: vi.fn(() => ({ counts: {}, show: vi.fn(), incrementCount: vi.fn() })),
  },
}));
vi.mock("../../../KeybindingService", () => ({
  keybindingService: { getEffectiveCombo: vi.fn(() => null), getDisplayCombo: vi.fn(() => "") },
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

// workflowCreationActions reaches into the renderer-only client/store layer at
// module load; stub those so the definitions register in a node test.
vi.mock("@/clients", () => ({
  worktreeClient: {},
  copyTreeClient: {},
  forgeClient: {},
}));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { getState: vi.fn() } }));
vi.mock("@/store/recipeStore", () => ({ useRecipeStore: { getState: vi.fn() } }));
vi.mock("@/store/createWorktreeStore", () => ({ getCurrentViewStore: vi.fn() }));
vi.mock("@/store/preferencesStore", () => ({ usePreferencesStore: { getState: vi.fn() } }));

import { ActionService } from "../../../ActionService";
import { registerWorkflowCreationActions } from "../workflowCreationActions";

function registerAll(): ActionService {
  const registry: ActionRegistry = new Map();
  registerWorkflowCreationActions(registry, {} as Pick<ActionCallbacks, "onLaunchAgent">);
  const service = new ActionService();
  for (const [, factory] of registry) {
    service.register(factory() as AnyActionDefinition);
  }
  return service;
}

function outputSchema(service: ActionService, id: string): Record<string, unknown> | undefined {
  return service.get(id as ActionId)?.outputSchema as Record<string, unknown> | undefined;
}

/**
 * #11547 — `workflow.startWorkOnIssue` had a complete resultSchema but never set
 * `mcpOutputSchema`, so the one action tying an issue to a running agent handed
 * callers a text blob and nothing structured. These assert the *generated*
 * schema through the real ActionService rather than the literal flag, so the
 * tierAuth `type === "object"` gate is exercised end to end.
 */
describe("workflow.startWorkOnIssue emits a manifest outputSchema (#11547)", () => {
  const RESULT_FIELDS = [
    "issueNumber",
    "issueTitle",
    "issueUrl",
    "worktreeId",
    "worktreePath",
    "branch",
    "terminalId",
    "recipeLaunched",
    "spawnedTerminalCount",
    "failedTerminalCount",
    "assignedToSelf",
    "assignedUsername",
    "assignmentError",
    "contextInjected",
  ];

  it("generates an object-typed outputSchema", () => {
    const schema = outputSchema(registerAll(), "workflow.startWorkOnIssue");
    expect(schema).toBeDefined();
    expect(schema!.type).toBe("object");
  });

  it("advertises the full issue-to-agent identity", () => {
    const schema = outputSchema(registerAll(), "workflow.startWorkOnIssue")!;
    const props = Object.keys((schema.properties as Record<string, unknown>) ?? {});
    expect(props.sort()).toEqual([...RESULT_FIELDS].sort());
  });

  it("requires every advertised field", () => {
    const schema = outputSchema(registerAll(), "workflow.startWorkOnIssue")!;
    const required = ((schema.required as string[] | undefined) ?? []).slice().sort();
    expect(required).toEqual([...RESULT_FIELDS].sort());
  });

  it("does not flip the flag on its sibling worktree.createWithRecipe", () => {
    // The neighbour in the same module has no mcpOutputSchema; enabling one
    // action must not quietly enable the other.
    expect(outputSchema(registerAll(), "worktree.createWithRecipe")).toBeUndefined();
  });
});
