// Introspecting a generated JSON Schema means narrowing `unknown` records at
// every step; same trade-off (and same waiver) as agentLaunchOutputSchema.
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
import { describe, expect, it, vi } from "vitest";
import type { ActionId } from "@shared/types/actions";
import type { ActionContext } from "@shared/types/actions";
import type { ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import { MCP_EXTERNAL_TIER_TOOLS } from "@shared/config/mcpExternalTierAllowlist";
import { WORKBENCH_TIER_TOOLS } from "@shared/config/helpAssistantTierAllowlists";

const workspaceClientMock = vi.hoisted(() => ({ list: vi.fn() }));

// ActionService pulls the shortcut-hint store, keybinding service and notify in
// at module load; registration only needs them to import cleanly.
vi.mock("../../../../store/shortcutHintStore", () => ({
  shortcutHintStore: {
    getState: vi.fn(() => ({ counts: {}, show: vi.fn(), incrementCount: vi.fn() })),
  },
}));
vi.mock("../../../KeybindingService", () => ({
  keybindingService: { getEffectiveCombo: vi.fn(() => null), getDisplayCombo: vi.fn(() => "") },
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/clients/workspaceClient", () => ({ workspaceClient: workspaceClientMock }));

import { ActionService } from "../../../ActionService";
import { registerWorkspaceActions } from "../workspaceActions";

function service(): ActionService {
  const registry: ActionRegistry = new Map();
  registerWorkspaceActions(registry);
  const svc = new ActionService();
  for (const [, factory] of registry) svc.register(factory() as AnyActionDefinition);
  return svc;
}

function definition(): AnyActionDefinition {
  const registry: ActionRegistry = new Map();
  registerWorkspaceActions(registry);
  const factory = registry.get("workspace.list" as never);
  if (!factory) throw new Error("workspace.list not registered");
  return factory() as AnyActionDefinition;
}

const ROW = {
  workspaceId: "a".repeat(64),
  path: "/repos/alpha",
  name: "Alpha",
  kind: "project" as const,
  hasLiveView: true,
};

describe("workspace.list", () => {
  it("is a safe, context-independent read", () => {
    const def = definition();

    expect(def.kind).toBe("query");
    expect(def.danger).toBe("safe");
    // No argsSchema and no context reads: discovery has to answer the same way
    // for a session bound anywhere, which is the whole point of a catalog.
    expect(def.argsSchema).toBeUndefined();
  });

  it("is admitted at the external tier and at workbench", () => {
    // Two independently curated lists (#10712). The external tier must never
    // reach past what the in-app assistant already can, so both or neither.
    expect(MCP_EXTERNAL_TIER_TOOLS as readonly string[]).toContain("workspace.list");
    expect(WORKBENCH_TIER_TOOLS as readonly string[]).toContain("workspace.list");
  });

  it("advertises an object-rooted output schema carrying all five fields", () => {
    // `buildToolOutputSchema` drops any schema whose root is not an object, so
    // the array has to be wrapped or the contract silently vanishes.
    const schema = service().get("workspace.list" as ActionId)?.outputSchema as
      Record<string, unknown> | undefined;

    expect(schema).toBeDefined();
    expect(schema!["type"]).toBe("object");

    const properties = schema!["properties"] as Record<string, Record<string, unknown>>;
    const row = properties["workspaces"]["items"] as Record<string, unknown>;
    expect(Object.keys(row["properties"] as Record<string, unknown>).sort()).toEqual([
      "hasLiveView",
      "kind",
      "name",
      "path",
      "workspaceId",
    ]);
    expect((row["required"] as string[]).sort()).toEqual([
      "hasLiveView",
      "kind",
      "name",
      "path",
      "workspaceId",
    ]);
  });

  it("describes what hasLiveView does and does not mean", () => {
    const { description } = definition();

    // The correction the issue turned on: a structurally valid unknown id
    // completes the binding handshake, so catalog membership is what separates
    // a wrong id from a closed workspace — not this flag. A description that
    // loses this sends callers back to hashing paths.
    expect(description).toMatch(/Daintree-Workspace-Id/);
    expect(description.toLowerCase()).toMatch(/hash/);
    expect(description).toMatch(/absence from this list/i);
    expect(Buffer.byteLength(description, "utf8")).toBeLessThanOrEqual(400);
    expect(Buffer.byteLength(description, "utf8")).toBeGreaterThanOrEqual(120);
  });

  it("returns the catalog under a `workspaces` key and validates against its schema", async () => {
    workspaceClientMock.list.mockResolvedValue([ROW]);

    // `dispatch` parses through `resultSchema` before returning, so this also
    // proves the published projection accepts a real row rather than stripping
    // fields out of it.
    const outcome = await service().dispatch("workspace.list" as ActionId, {}, {} as ActionContext);

    expect(outcome).toMatchObject({ ok: true, result: { workspaces: [ROW] } });
  });

  it("passes an empty catalog through rather than failing", async () => {
    workspaceClientMock.list.mockResolvedValue([]);

    const outcome = await service().dispatch("workspace.list" as ActionId, {}, {} as ActionContext);

    expect(outcome).toMatchObject({ ok: true, result: { workspaces: [] } });
  });
});
