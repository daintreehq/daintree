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

// terminalQueryActions reaches into the renderer-only client/store layer at
// module load; stub those so the definitions register in a node test.
vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: vi.fn() } }));
vi.mock("@/store/fleetArmingStore", () => ({
  useFleetArmingStore: { getState: () => ({ armedIds: new Set<string>() }) },
}));
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

  it("terminal.getStatus advertises the `armed` flag in its per-entry schema (#10695)", () => {
    const schema = outputSchema(registerAll(), "terminal.getStatus")!;
    const items = (schema.properties as { terminals: { items?: Record<string, unknown> } })
      .terminals.items;
    const props = (items?.properties as Record<string, unknown>) ?? {};
    // An MCP client introspecting structuredContent must see `armed` so the
    // read path stays discoverable if the schema field is ever dropped.
    expect(props.armed).toBeDefined();
  });

  it("terminal.getOutput exposes content/lineCount/truncated properties", () => {
    const props =
      (outputSchema(registerAll(), "terminal.getOutput")!.properties as Record<string, unknown>) ??
      {};
    expect(props.content).toBeDefined();
    expect(props.lineCount).toBeDefined();
    expect(props.truncated).toBeDefined();
  });

  it("does not mark terminal.list's `type` as required (runtime emits it undefined)", () => {
    // terminal.list returns `type: undefined`, which drops on JSON serialization,
    // so the advertised schema must not require the key — otherwise a strict MCP
    // client validating structuredContent against outputSchema would reject it.
    const schema = outputSchema(registerAll(), "terminal.list")!;
    const items = (schema.properties as { terminals: { items?: Record<string, unknown> } })
      .terminals.items;
    const required = (items?.required as string[] | undefined) ?? [];
    expect(required).not.toContain("type");
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

// #12308 — `owned` is advertised on the tool but answered in main, against the
// MCP session's ownership ledger. These go through the real ActionService so
// they exercise the published input schema and the dispatch path a caller that
// bypasses main would actually take.
describe("terminal.list owned input contract (#12308)", () => {
  function listEntry(service: ActionService) {
    return service.get("terminal.list" as ActionId);
  }

  it("advertises owned as an optional boolean with its own description", () => {
    const schema = listEntry(registerAll())?.inputSchema;

    expect(schema).toMatchObject({
      properties: { owned: { type: "boolean", description: expect.any(String) } },
    });
    // Optional in the published contract: a client holding a cached tools/list
    // that never sends the field must keep getting today's behaviour.
    expect(schema?.required ?? []).not.toContain("owned");
  });

  it("keeps the argument's semantics out of the 400-byte tool description", () => {
    const description = listEntry(registerAll())?.description ?? "";
    // The description already sits at 384 of its 400 bytes, so the field's
    // meaning has to live in `.describe()` — where it reaches a client anyway.
    expect(Buffer.byteLength(description, "utf8")).toBeLessThanOrEqual(400);
    expect(description).not.toContain("owned");
  });

  it("refuses a real dispatch rather than answering it with the full list", async () => {
    // Every non-MCP caller — the in-app assistant, a keybinding, a plugin, a
    // test — converges on this method, and `run()` cannot tell them apart. An
    // unfiltered list here would be a wrong answer, not a missing feature.
    for (const source of ["agent", "user", "plugin"] as const) {
      const result = await registerAll().dispatch(
        "terminal.list" as ActionId,
        { owned: true },
        { source }
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.message).toMatch(/owned/);
    }
  });

  it("rejects a non-boolean owned at schema validation", async () => {
    // Main forwards a non-boolean untouched precisely so this gate sees it,
    // instead of a strip laundering it into a legal request.
    const result = await registerAll().dispatch("terminal.list" as ActionId, { owned: "yes" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("VALIDATION_ERROR");
  });
});
