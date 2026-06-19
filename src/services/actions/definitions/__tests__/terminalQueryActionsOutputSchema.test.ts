import { describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionId, AnyActionDefinition } from "@shared/types/actions";
import type { ActionRegistry } from "../../actionTypes";

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

// terminalQueryActions reaches into the renderer-only client/store layer at
// module load; stub those so the definitions register in a node test.
vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: vi.fn() } }));
vi.mock("@/clients", () => ({ terminalClient: { submit: vi.fn() } }));
vi.mock("@shared/config/panelKindRegistry", () => ({
  panelKindHasPty: (kind: string) => kind === "terminal" || kind === "agent",
}));

import { ActionService } from "../../../ActionService";
import { registerTerminalQueryActions } from "../terminalQueryActions";

function registerAll(): ActionService {
  const registry: ActionRegistry = new Map();
  registerTerminalQueryActions(registry, {} as ActionCallbacks);
  const service = new ActionService();
  for (const [, factory] of registry) {
    service.register(factory() as AnyActionDefinition);
  }
  return service;
}

function outputSchema(service: ActionService, id: string): Record<string, unknown> | undefined {
  return service.get(id as ActionId)?.outputSchema as Record<string, unknown> | undefined;
}

// #10676 — the three high-value query actions opt into MCP structuredContent by
// carrying `mcpOutputSchema: true` alongside a top-level object resultSchema.
// Registering through the real ActionService exercises the Zod -> JSON Schema
// conversion, so these assert the *generated* schema, not the literal flag.
describe("terminal query actions emit a manifest outputSchema (#10676)", () => {
  const HIGH_VALUE = ["terminal.list", "terminal.getStatus", "terminal.getOutput"];

  it.each(HIGH_VALUE)("%s generates an object-typed outputSchema", (id) => {
    const schema = outputSchema(registerAll(), id);
    expect(schema).toBeDefined();
    expect(schema!.type).toBe("object");
    // buildToolOutputSchema (tierAuth) only forwards object-typed schemas, and
    // buildStructuredContent only attaches it when the schema is present — so a
    // missing or non-object schema would silently drop structuredContent.
    expect(schema!.properties).toBeDefined();
  });

  it("terminal.list / terminal.getStatus expose the `terminals` array property", () => {
    const service = registerAll();
    for (const id of ["terminal.list", "terminal.getStatus"]) {
      const props = (outputSchema(service, id)!.properties as Record<string, unknown>) ?? {};
      expect(props.terminals).toBeDefined();
    }
  });

  it("terminal.getOutput exposes content/lineCount/truncated properties", () => {
    const props =
      (outputSchema(registerAll(), "terminal.getOutput")!.properties as Record<string, unknown>) ??
      {};
    expect(props.content).toBeDefined();
    expect(props.lineCount).toBeDefined();
    expect(props.truncated).toBeDefined();
  });

  // The watchout from the issue: do not flip the flag on neighbours. waitUntilIdle
  // uses the main-process rawOutputSchema path (no mcpOutputSchema flag), and
  // sendCommand has no resultSchema at all — both must stay schema-less here.
  it("does not emit an outputSchema for terminal.waitUntilIdle or terminal.sendCommand", () => {
    const service = registerAll();
    expect(outputSchema(service, "terminal.waitUntilIdle")).toBeUndefined();
    expect(outputSchema(service, "terminal.sendCommand")).toBeUndefined();
  });
});
