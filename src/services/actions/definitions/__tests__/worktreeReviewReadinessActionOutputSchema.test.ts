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

// worktreeContextActions reaches into the renderer-only client/store layer at
// module load; stub those so the definitions register in a node test.
vi.mock("@/clients", () => ({
  copyTreeClient: { generateAndCopyFile: vi.fn() },
  systemClient: { openPath: vi.fn() },
}));
vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: vi.fn(() => ({ getState: () => ({ worktrees: new Map() }) })),
}));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: vi.fn(() => ({})) },
}));
vi.mock("@/store/uiStore", () => ({ useUIStore: { getState: vi.fn(() => ({})) } }));
vi.mock("@/store/forgeProviderHealthStore", () => ({
  useForgeProviderHealthStore: { getState: vi.fn(() => ({ providers: {} })) },
}));
vi.mock("@/lib/copyTreeFormat", () => ({ DEFAULT_COPYTREE_FORMAT: "xml" }));

import { ActionService } from "../../../ActionService";
import { registerWorktreeContextActions } from "../worktreeContextActions";

function registerAll(): ActionService {
  const registry: ActionRegistry = new Map();
  registerWorktreeContextActions(registry, { onInject: vi.fn() } as unknown as ActionCallbacks);
  const service = new ActionService();
  for (const [, factory] of registry) {
    service.register(factory() as AnyActionDefinition);
  }
  return service;
}

function outputSchema(service: ActionService, id: string): Record<string, unknown> | undefined {
  return service.get(id as ActionId)?.outputSchema as Record<string, unknown> | undefined;
}

describe("worktree.reviewReadiness emits a manifest outputSchema", () => {
  it("generates an object-typed outputSchema with the readiness fields", () => {
    const schema = outputSchema(registerAll(), "worktree.reviewReadiness");
    expect(schema).toBeDefined();
    expect(schema!.type).toBe("object");
    const props = (schema!.properties as Record<string, unknown>) ?? {};
    for (const key of [
      "worktreeId",
      "level",
      "commitReady",
      "pushReady",
      "prReady",
      "blockers",
      "warnings",
      "infos",
      "nextActions",
      "counts",
      "aheadCount",
      "behindCount",
      "pr",
      "forge",
    ]) {
      expect(props[key], `missing outputSchema property: ${key}`).toBeDefined();
    }
  });

  it("marks the summary fields as required and encodes the closed vocabularies", () => {
    const schema = outputSchema(registerAll(), "worktree.reviewReadiness");
    expect(schema!.required as string[]).toEqual(
      expect.arrayContaining([
        "worktreeId",
        "level",
        "commitReady",
        "pushReady",
        "prReady",
        "blockers",
        "warnings",
        "counts",
        "forge",
      ])
    );
    const json = JSON.stringify(schema);
    for (const level of ["ready", "needs-review", "blocked", "unknown"]) {
      expect(json).toContain(`"${level}"`);
    }
    // Item ids and suggested action ids are closed enums, not bare strings.
    expect(json).toContain('"nothing-staged"');
    expect(json).toContain('"worktree.openReviewHub"');
    // prReady must encode the boolean | "unknown" union.
    const props = schema!.properties as Record<string, unknown>;
    expect(JSON.stringify(props.prReady)).toContain("boolean");
    expect(JSON.stringify(props.prReady)).toContain('"unknown"');
  });

  it("does not require any input arguments", () => {
    const entry = registerAll().get("worktree.reviewReadiness" as ActionId);
    const required = (entry?.inputSchema as { required?: string[] } | undefined)?.required;
    expect(required ?? []).toEqual([]);
  });

  it("classifies the action as a read-only query with read-only annotations", () => {
    const entry = registerAll().get("worktree.reviewReadiness" as ActionId);
    expect(entry?.kind).toBe("query");
    expect(entry?.danger).toBe("safe");
    expect(entry?.mcpAnnotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
    });
  });
});
