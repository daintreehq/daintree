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

  it("terminal.getStatus advertises hasPty as an optional plain boolean (#12336)", () => {
    const schema = outputSchema(registerAll(), "terminal.getStatus")!;
    const items = (schema.properties as { terminals: { items?: Record<string, unknown> } })
      .terminals.items;
    const props = (items?.properties as Record<string, { type?: unknown }>) ?? {};

    // Advertised, or an introspecting client never learns the read exists.
    expect(props.hasPty).toBeDefined();
    // A plain boolean, not an anyOf/null union: the renderer answer omits the
    // key entirely rather than sending `null`, and a third representation
    // would give a poller a state neither builder ever produces.
    expect(props.hasPty?.type).toBe("boolean");
    // Optional, because the surface that cannot observe it sends no key. A
    // required field would make every renderer-sourced answer fail a strict
    // client's structuredContent validation.
    const required = (items?.required as string[] | undefined) ?? [];
    expect(required).not.toContain("hasPty");
  });

  it("terminal.getStatus admits hasPty in its unavailableFields enum (#12336)", () => {
    // The renderer path answers `unavailableFields: ["hasPty"]`. Entry schema
    // and envelope have to land together — widening only the entry ships a
    // manifest whose own envelope rejects the answer the action returns.
    const schema = outputSchema(registerAll(), "terminal.getStatus")!;
    const unavailable = (
      schema.properties as { unavailableFields: { items?: { enum?: string[] } } }
    ).unavailableFields.items;
    expect(unavailable?.enum).toContain("hasPty");
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

  // Still the watchout from #10676: do not flip the flag on neighbours.
  // sendCommand has no resultSchema at all and must stay schema-less. (The two
  // wait tools deliberately opted in under #12339 — covered below.)
  it("does not emit an outputSchema for terminal.sendCommand", () => {
    expect(outputSchema(registerAll(), "terminal.sendCommand")).toBeUndefined();
  });
});

// #12339 — both wait tools carry a hand-written rawOutputSchema but never set
// `mcpOutputSchema`, so `computeSchemas` left `outputSchema` undefined and
// tools/list advertised nothing — while the main-process path was already
// attaching `structuredContent` with no schema to validate it against.
describe("wait tools advertise their output schema (#12339)", () => {
  const WAIT_TOOLS = ["terminal.waitUntilIdle", "terminal.waitUntilIdleBatch"];

  it.each(WAIT_TOOLS)("%s generates an object-typed outputSchema", (id) => {
    const schema = outputSchema(registerAll(), id);
    expect(schema).toBeDefined();
    // buildToolOutputSchema (tierAuth) drops anything that is not a top-level
    // object, which would silently re-disarm the advertisement.
    expect(schema!.type).toBe("object");
    expect(schema!.properties).toBeDefined();
  });

  it("terminal.waitUntilIdle advertises trackingState as a required enum", () => {
    const schema = outputSchema(registerAll(), "terminal.waitUntilIdle")!;
    const props = schema.properties as Record<string, { enum?: string[] }>;
    expect(props.trackingState?.enum).toEqual(["tracked", "closed", "unknown"]);
    // Required so a reconciler can rely on it being present on every result
    // rather than treating its absence as tracked.
    expect(schema.required as string[]).toContain("trackingState");
  });

  it("terminal.waitUntilIdleBatch advertises trackingState on every row", () => {
    const schema = outputSchema(registerAll(), "terminal.waitUntilIdleBatch")!;
    const items = (schema.properties as { results: { items?: Record<string, unknown> } }).results
      .items!;
    const props = items.properties as Record<string, { enum?: string[] }>;
    expect(props.trackingState?.enum).toEqual(["tracked", "closed", "unknown"]);
    expect(items.required as string[]).toContain("trackingState");
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
      // The tool description has no room for the field's semantics, so an
      // empty `.describe()` would ship the argument undocumented.
      properties: { owned: { type: "boolean", description: expect.stringMatching(/\S/) } },
    });
    // Optional in the published contract: a client holding a cached tools/list
    // that never sends the field must keep getting today's behaviour.
    expect(schema?.required ?? []).not.toContain("owned");
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
