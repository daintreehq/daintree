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
// `agentActions` reaches the agent-settings store, which pulls in the CLI
// availability store, which calls `getAgentIds()` at module eval — so the
// partial `@/config/agents` mock above would have to carry that export for a
// module nothing here exercises. Stubbing the two stores keeps the mock
// describing what this suite actually uses (matching agentBookmarkActions and
// agentActions.adversarial).
vi.mock("@/store/agentSettingsStore", () => ({
  useAgentSettingsStore: { getState: vi.fn(() => ({ settings: undefined })) },
}));
vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: { getState: vi.fn(() => ({ availability: {} })) },
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
  /** Run the action with a launcher that reports a full identity. */
  async function runLaunch(
    launcherResult: Record<string, unknown> | null
  ): Promise<Record<string, unknown>> {
    const registry: ActionRegistry = new Map();
    registerAgentActions(registry, {
      onLaunchAgent: () => Promise.resolve(launcherResult),
    } as unknown as ActionCallbacks);
    const def = registry.get("agent.launch")!() as AnyActionDefinition;
    return (await def.run({ agentId: "claude" }, {} as never)) as Record<string, unknown>;
  }

  const LAUNCHED = {
    terminalId: "term-1",
    location: "grid",
    worktreeId: "wt-1",
    worktreePath: "/repo/wt-1",
    branch: "feature/x",
    cwd: "/repo/wt-1",
  };

  it("generates an object-typed outputSchema", () => {
    // The exact gate in buildToolOutputSchema (tierAuth): a top-level `anyOf`,
    // which is what a `.nullable()` object renders as, has no `type` and is
    // silently dropped — leaving mcpOutputSchema a no-op.
    const schema = outputSchema(registerAll(), "agent.launch");
    expect(schema).toBeDefined();
    expect(schema!.type).toBe("object");
  });

  it("advertises exactly the keys run() emits, in both result shapes", async () => {
    // Cross-check rather than a copy of the schema's own field list: nothing
    // validates run()'s literal against resultSchema at runtime, so the only
    // real invariant is that the two agree.
    const advertised = Object.keys(
      (outputSchema(registerAll(), "agent.launch")!.properties as Record<string, unknown>) ?? {}
    ).sort();

    expect(Object.keys(await runLaunch(LAUNCHED)).sort()).toEqual(advertised);
    expect(Object.keys(await runLaunch(null)).sort()).toEqual(advertised);
  });

  it("requires every advertised key, so absent is never a third state beside null", () => {
    const schema = outputSchema(registerAll(), "agent.launch")!;
    const props = Object.keys((schema.properties as Record<string, unknown>) ?? {});
    const required = (schema.required as string[] | undefined) ?? [];
    // An optional field would let a strict client distinguish missing from
    // null; run() always emits all of them, nullable and never omitted.
    expect([...required].sort()).toEqual([...props].sort());
  });

  it("admits null on every key that run() can emit as null", async () => {
    const declined = await runLaunch(null);
    const props = outputSchema(registerAll(), "agent.launch")!.properties as Record<
      string,
      { anyOf?: Array<{ type?: string }>; type?: string }
    >;

    // Derived from an actual all-null result, so a newly nullable field is
    // covered without editing a hardcoded list.
    for (const [key, value] of Object.entries(declined)) {
      if (value !== null) continue;
      const variants = props[key]?.anyOf ?? [];
      expect(variants.some((v) => v.type === "null")).toBe(true);
    }
    // `launched` is the discriminant — the one key that is never null.
    expect(declined.launched).toBe(false);
    expect(props.launched?.type).toBe("boolean");
  });

  it("does not advertise 'overlay' as a returnable location", () => {
    // `location` accepts overlay as an *argument*, but the launcher collapses
    // anything non-dock to "grid" before returning — advertising overlay in the
    // output would promise a value structuredContent can never carry.
    const props = outputSchema(registerAll(), "agent.launch")!.properties as Record<
      string,
      { anyOf?: Array<{ enum?: string[] }> }
    >;
    const enums = (props.location?.anyOf ?? []).flatMap((v) => v.enum ?? []);
    expect(enums).not.toContain("overlay");
    expect(enums).toContain("grid");
  });
});
