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

// agentActions reaches into the renderer-only client/store layer at module
// load; stub those so the definitions register in a node test.
vi.mock("@/store/panelStore", () => ({ usePanelStore: { getState: vi.fn() } }));
vi.mock("@/store/createWorktreeStore", () => ({ getCurrentViewStore: vi.fn() }));
vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: { getState: vi.fn(() => ({ activeWorktreeId: null })) },
}));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { getState: vi.fn() } }));
vi.mock("@/store/projectStatsStore", () => ({ useProjectStatsStore: { getState: vi.fn() } }));
vi.mock("@/config/agents", () => ({
  AGENT_REGISTRY: { claude: { name: "Claude" } },
  getAgentDisplayTitle: vi.fn((id: string) => `Title:${id}`),
}));
vi.mock("@/clients/userAgentRegistryClient", () => ({
  userAgentRegistryClient: { get: vi.fn() },
}));
vi.mock("@/clients", () => ({
  agentSettingsClient: { get: vi.fn() },
  cliAvailabilityClient: { get: vi.fn() },
  agentCapabilitiesClient: { getRegistry: vi.fn() },
}));

import { ActionService } from "../../../ActionService";
import { registerAgentActions } from "../agentActions";

function registerAll(): ActionService {
  const registry: ActionRegistry = new Map();
  registerAgentActions(registry, {} as ActionCallbacks);
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
 * #11547 — `agent.launch` carried `mcpOutputSchema: true` alongside a
 * `z.object({...}).nullable()` resultSchema, which Zod renders as a top-level
 * `anyOf` with no `"type"`. `buildToolOutputSchema` (tierAuth) forwards a schema
 * only when `schema.type === "object"`, so the flag was a complete no-op: no
 * outputSchema in `tools/list`, no `structuredContent` in any response. These
 * assert the *generated* schema through the real ActionService, which is the
 * only thing that would have caught it.
 */
describe("agent.launch emits a manifest outputSchema (#11547)", () => {
  const PUBLIC_FIELDS = [
    "launched",
    "terminalId",
    "location",
    "spawnStatus",
    "worktreeId",
    "worktreePath",
    "branch",
    "cwd",
  ];

  it("generates an object-typed outputSchema, not a nullable anyOf", () => {
    const schema = outputSchema(registerAll(), "agent.launch");
    expect(schema).toBeDefined();
    expect(schema!.type).toBe("object");
    // The exact gate in buildToolOutputSchema — a top-level `anyOf` (what a
    // nullable object produces) has no `type` and is silently dropped.
    expect(schema!.anyOf).toBeUndefined();
  });

  it("advertises every field agent.launch actually returns", () => {
    const schema = outputSchema(registerAll(), "agent.launch")!;
    const props = Object.keys((schema.properties as Record<string, unknown>) ?? {});
    expect(props.sort()).toEqual([...PUBLIC_FIELDS].sort());
  });

  it("marks every field required so a strict client never sees a missing key", () => {
    const schema = outputSchema(registerAll(), "agent.launch")!;
    const required = ((schema.required as string[] | undefined) ?? []).slice().sort();
    // run() always emits all eight — nullable, never omitted. Optional fields
    // would let a client treat "absent" as a third state alongside null.
    expect(required).toEqual([...PUBLIC_FIELDS].sort());
  });

  it("admits null on every field the launcher may not resolve", () => {
    const props = outputSchema(registerAll(), "agent.launch")!.properties as Record<
      string,
      { anyOf?: Array<{ type?: string }>; type?: string }
    >;
    for (const field of ["terminalId", "location", "spawnStatus", "worktreeId", "branch", "cwd"]) {
      const variants = props[field]?.anyOf ?? [];
      expect(variants.some((v) => v.type === "null")).toBe(true);
    }
    // `launched` is the discriminant and is never null.
    expect(props.launched?.type).toBe("boolean");
  });

  it("does not advertise 'overlay' as a returnable location", () => {
    // `location` accepts overlay as an *argument*, but the launcher collapses
    // anything non-dock to "grid" before returning — advertising overlay in the
    // output would promise a value structuredContent can never carry.
    const serialized = JSON.stringify(outputSchema(registerAll(), "agent.launch"));
    expect(serialized).not.toContain("overlay");
  });
});
