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

  it("keeps the six result families structurally distinct", () => {
    const service = registerAll();
    // Each action must report the state IT changed. Comparing the families to
    // each other (rather than to a copied field list) catches the real
    // regression: two families collapsing onto one schema.
    const representatives = [
      "forge.assignIssue",
      "forge.approvePR",
      "forge.requestReviewers",
      "forge.closePR",
      "forge.mergePR",
      "forge.convertPRToDraft",
      "forge.commentOnPR",
    ];
    const signatures = representatives.map((id) =>
      propertyNames(outputSchema(service, id)).join(",")
    );

    expect(new Set(signatures).size).toBe(representatives.length);
  });

  it("names at least one required field per action, so a result is never all-optional", () => {
    const service = registerAll();
    // An all-optional schema promises nothing: a client could not rely on any
    // field being present. Derived from the generated schemas — no field list
    // is restated here.
    for (const id of WRITE_ACTIONS) {
      const required = (outputSchema(service, id)?.required ?? []) as string[];
      expect(required.length).toBeGreaterThan(0);
    }
  });

  it("keeps the array-shaped label actions opted out at the ActionService layer", () => {
    const service = registerAll();
    // A policy assertion, not a wire-behavior one: addIssueLabel and
    // removeIssueLabel carry an ARRAY resultSchema, and MCP structuredContent
    // must be an object. buildToolOutputSchema would drop an array schema
    // anyway, so this guards the intent — they stay opted out until their
    // result is reshaped into an object.
    expect(outputSchema(service, "forge.addIssueLabel")).toBeUndefined();
    expect(outputSchema(service, "forge.removeIssueLabel")).toBeUndefined();
  });
});
