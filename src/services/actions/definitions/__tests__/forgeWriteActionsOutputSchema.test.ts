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
vi.mock("@/clients", () => ({ forgeClient: {} }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { getState: vi.fn() } }));

import { ActionService } from "../../../ActionService";
import { registerForgeActions } from "../forgeActions";

function registerAll(): ActionService {
  const registry: ActionRegistry = new Map();
  registerForgeActions(registry, {} as ActionCallbacks);
  const service = new ActionService();
  for (const [, factory] of registry) {
    service.register(factory() as AnyActionDefinition);
  }
  return service;
}

function outputSchema(service: ActionService, id: string): Record<string, unknown> | undefined {
  return service.get(id as ActionId)?.outputSchema as Record<string, unknown> | undefined;
}

function propertyNames(schema: Record<string, unknown> | undefined): string[] {
  const props = schema?.properties as Record<string, unknown> | undefined;
  return props ? Object.keys(props).sort() : [];
}

// #11546 — the twelve forge write actions used to return void with no
// resultSchema, so an agent driving them through MCP learned nothing about what
// changed. `outputSchema` is published only when BOTH `mcpOutputSchema` and
// `resultSchema` are set (ActionService.computeSchemas), so these register
// through the real ActionService and assert the *generated* schema rather than
// the literal flag — the flag alone never reaches the wire.
describe("forge write actions publish a manifest outputSchema (#11546)", () => {
  const WRITE_ACTIONS = [
    "forge.assignIssue",
    "forge.unassignIssue",
    "forge.approvePR",
    "forge.requestChanges",
    "forge.dismissReview",
    "forge.requestReviewers",
    "forge.closePR",
    "forge.reopenPR",
    "forge.mergePR",
    "forge.convertPRToDraft",
    "forge.markPRReadyForReview",
    "forge.commentOnPR",
  ];

  it.each(WRITE_ACTIONS)("%s generates an object-typed outputSchema", (id) => {
    const schema = outputSchema(registerAll(), id);
    expect(schema).toBeDefined();
    // buildToolOutputSchema (tierAuth) forwards only object-typed schemas, and
    // buildStructuredContent attaches structuredContent only when a schema is
    // present — an array or missing schema silently drops it on the wire.
    expect(schema!.type).toBe("object");
    expect(propertyNames(schema).length).toBeGreaterThan(0);
  });

  it("distinguishes each result family by the fields it publishes", () => {
    const service = registerAll();
    // The point of the issue is that each action reports the state IT changed,
    // so the families must not collapse onto one another's shape.
    expect(propertyNames(outputSchema(service, "forge.mergePR"))).toEqual([
      "merged",
      "message",
      "prNumber",
      "sha",
    ]);
    expect(propertyNames(outputSchema(service, "forge.assignIssue"))).toEqual([
      "assignees",
      "issueNumber",
    ]);
    expect(propertyNames(outputSchema(service, "forge.convertPRToDraft"))).toEqual([
      "isDraft",
      "prNumber",
    ]);
    expect(propertyNames(outputSchema(service, "forge.requestReviewers"))).toEqual([
      "prNumber",
      "requestedTeams",
      "requestedUsers",
    ]);
    expect(propertyNames(outputSchema(service, "forge.approvePR"))).toContain("rawState");
  });

  it("gives the two draft toggles and the two assignment actions matching shapes", () => {
    const service = registerAll();
    // Same result family => same published contract; a drift here means an
    // agent has to special-case which direction it called.
    expect(propertyNames(outputSchema(service, "forge.convertPRToDraft"))).toEqual(
      propertyNames(outputSchema(service, "forge.markPRReadyForReview"))
    );
    expect(propertyNames(outputSchema(service, "forge.assignIssue"))).toEqual(
      propertyNames(outputSchema(service, "forge.unassignIssue"))
    );
    expect(propertyNames(outputSchema(service, "forge.approvePR"))).toEqual(
      propertyNames(outputSchema(service, "forge.requestChanges"))
    );
    expect(propertyNames(outputSchema(service, "forge.dismissReview"))).toEqual(
      propertyNames(outputSchema(service, "forge.approvePR"))
    );
    expect(propertyNames(outputSchema(service, "forge.closePR"))).toEqual(
      propertyNames(outputSchema(service, "forge.reopenPR"))
    );
  });

  it("leaves the array-shaped label results unpublished", () => {
    const service = registerAll();
    // addIssueLabel/removeIssueLabel carry an ARRAY resultSchema. MCP
    // structuredContent must be an object, so opting these in would publish an
    // unusable array schema — they stay out until their result is reshaped.
    expect(outputSchema(service, "forge.addIssueLabel")).toBeUndefined();
    expect(outputSchema(service, "forge.removeIssueLabel")).toBeUndefined();
  });
});
