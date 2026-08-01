// @vitest-environment jsdom
// Introspecting a generated JSON Schema means narrowing `unknown` records at
// every step; same trade-off (and same waiver) as agentLaunchOutputSchema.
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
import { describe, expect, it, vi } from "vitest";
import type { ActionId } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

// ActionService pulls in the shortcut-hint store, keybinding service, and notify
// at module load / dispatch time. Registration only needs the module to import
// cleanly, so stub them out. `@/services/ActionService` itself is deliberately
// NOT mocked — the generated schema is what this asserts, and only the real
// service produces it.
vi.mock("../../../../store/shortcutHintStore", () => ({
  shortcutHintStore: {
    getState: vi.fn(() => ({ counts: {}, show: vi.fn(), incrementCount: vi.fn() })),
  },
}));
vi.mock("../../../KeybindingService", () => ({
  keybindingService: { getEffectiveCombo: vi.fn(() => null), getDisplayCombo: vi.fn(() => "") },
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: () => ({}) } }));
vi.mock("@/store/portalStore", () => ({ usePortalStore: { getState: () => ({}) } }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { getState: () => ({}) } }));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: () => ({}) },
}));
vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({ getState: () => ({ worktrees: new Map() }) }),
}));

import { ActionService } from "../../../ActionService";
import { registerIntrospectionActions } from "../introspectionActions";

function registerAll(): ActionService {
  const registry: ActionRegistry = new Map();
  registerIntrospectionActions(registry, {} as ActionCallbacks);
  const service = new ActionService();
  for (const [, factory] of registry) {
    service.register(factory() as AnyActionDefinition);
  }
  return service;
}

/**
 * `mcpOutputSchema: true` is a silent no-op unless the GENERATED JSON Schema has
 * a top-level `"type": "object"` — `buildToolOutputSchema` (tierAuth) drops
 * anything else, which is how `agent.launch` shipped advertising nothing at all
 * (#11547). `mcp.surface` exists to be parsed programmatically, so an
 * unadvertised schema would defeat the whole tool. Asserted through the real
 * ActionService, which is the only thing that would catch it.
 */
describe("mcp.surface emits a manifest outputSchema (#11549)", () => {
  function schemaOf(): Record<string, unknown> {
    const schema = registerAll().get("mcp.surface" as ActionId)?.outputSchema as
      Record<string, unknown> | undefined;
    expect(schema).toBeDefined();
    return schema!;
  }

  it("generates an object-typed outputSchema", () => {
    expect(schemaOf().type).toBe("object");
  });

  it("advertises every top-level field a client reads", () => {
    const props = Object.keys((schemaOf().properties as Record<string, unknown>) ?? {}).sort();

    // The four scalars plus the list — a client that cannot see one of these
    // cannot do the startup check the tool exists for.
    expect(props).toEqual(["appVersion", "hash", "manifestVersion", "tier", "tools"]);
  });

  it("requires every top-level field, so none is optional to a strict client", () => {
    const schema = schemaOf();
    const props = Object.keys((schema.properties as Record<string, unknown>) ?? {});
    const required = (schema.required as string[] | undefined) ?? [];

    expect([...required].sort()).toEqual([...props].sort());
  });

  it("advertises the per-tool fields, with deprecation as the only optional one", () => {
    const tools = (schemaOf().properties as Record<string, { items?: Record<string, unknown> }>)
      .tools;
    const items = tools?.items ?? {};
    const props = Object.keys((items.properties as Record<string, unknown>) ?? {}).sort();
    const required = ((items.required as string[] | undefined) ?? []).sort();

    expect(props).toEqual(["deprecated", "id", "idempotentHint", "kind", "readOnlyHint", "tier"]);
    // Presence is the deprecation signal, so it is the one field that may be
    // absent; everything else is always emitted.
    expect(required).toEqual(["id", "idempotentHint", "kind", "readOnlyHint", "tier"]);
  });
});

describe("mcp.surface registration", () => {
  it("is a safe read-only query in the introspection category", () => {
    const registry: ActionRegistry = new Map();
    registerIntrospectionActions(registry, {} as ActionCallbacks);
    const def = registry.get("mcp.surface" as ActionId)!() as AnyActionDefinition;

    expect(def.kind).toBe("query");
    expect(def.danger).toBe("safe");
    expect(def.category).toBe("introspection");
    expect(def.mcpVisibility).toBe("core");
  });

  it("refuses renderer dispatch, because only main knows the caller's tier", async () => {
    const registry: ActionRegistry = new Map();
    registerIntrospectionActions(registry, {} as ActionCallbacks);
    const def = registry.get("mcp.surface" as ActionId)!() as AnyActionDefinition;

    await expect(def.run(undefined as never, {} as never)).rejects.toThrow(/main-process path/);
  });

  it("takes no arguments, so a startup check needs nothing but the call", () => {
    const registry: ActionRegistry = new Map();
    registerIntrospectionActions(registry, {} as ActionCallbacks);
    const def = registry.get("mcp.surface" as ActionId)!() as AnyActionDefinition;

    expect(def.argsSchema).toBeUndefined();
  });
});
