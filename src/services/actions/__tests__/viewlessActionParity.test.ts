import { describe, it, expect, vi } from "vitest";

const hintMocks = vi.hoisted(() => ({
  getState: vi.fn(() => ({ hydrated: true, counts: {}, show: vi.fn(), incrementCount: vi.fn() })),
  getEffectiveCombo: vi.fn((_actionId: string): string | null => null),
  getDisplayCombo: vi.fn((_actionId: string): string => ""),
}));

vi.mock("@/store/shortcutHintStore", () => ({
  shortcutHintStore: { getState: hintMocks.getState },
}));
vi.mock("../../../store/shortcutHintStore", () => ({
  shortcutHintStore: { getState: hintMocks.getState },
}));
vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    getEffectiveCombo: hintMocks.getEffectiveCombo,
    getDisplayCombo: hintMocks.getDisplayCombo,
  },
}));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import type { ActionId } from "@shared/types/actions";
import { z } from "zod";
import { VIEWLESS_ACTIONS } from "../../../../electron/services/viewless/viewlessActionCatalog";
import {
  AgentSessionHistoryListArgsSchema,
  GitGetProjectPulseArgsSchema,
  SlashCommandsListArgsSchema,
  AgentLaunchArgsSchema,
  AgentLaunchInNewWorktreeArgsSchema,
  AgentListModelsArgsSchema,
  AgentListPresetsArgsSchema,
  RecipeListArgsSchema,
  VIEWLESS_FORGE_ARGS_SCHEMAS,
  WorktreeCreateWithRecipeArgsSchema,
  WorktreeWaitForPullRequestArgsSchema,
} from "../../../../electron/services/viewless/viewlessArgsSchemas";
import { createActionRegistry } from "./helpers/wireSurface";

function isZodSchema(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}

/** The top-level keys an args schema accepts, read off the JSON Schema it publishes. */
function acceptedKeys(schema: z.ZodType): string[] {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as {
    properties?: Record<string, unknown>;
  };
  return Object.keys(json.properties ?? {}).sort();
}

interface SourceArmJson {
  properties?: Record<string, { const?: unknown }>;
}

/**
 * `createWithRecipe`'s keys per source mode, by `kind`. The top-level keys
 * alone stop at `source`, so a field one side's arm gained (#15733's
 * `fetchBase`) would pass unnoticed.
 */
function sourceArmKeys(schema: z.ZodType): Record<string, string[]> {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as {
    properties?: { source?: { oneOf?: SourceArmJson[]; anyOf?: SourceArmJson[] } };
  };
  const source = json.properties?.source;
  const arms = source?.oneOf ?? source?.anyOf ?? [];
  return Object.fromEntries(
    arms.map((arm) => [
      String(arm.properties?.kind?.const),
      Object.keys(arm.properties ?? {}).sort(),
    ])
  );
}

/**
 * The host runs these actions itself when no frontend is attached (#13495),
 * admitting each against the danger its catalog restates. A definition that
 * gains a confirmation would otherwise run there unattended.
 */
describe("viewless action catalog", () => {
  it.each(Object.entries(VIEWLESS_ACTIONS))(
    "declares %s with its renderer definition's danger",
    async (id, entry) => {
      const registry = await createActionRegistry();
      const definition = registry.get(id as ActionId)?.();

      expect(definition, `${id} is not a registered action`).toBeDefined();
      expect(entry.danger).toBe(definition?.danger);
    }
  );
});

/**
 * The actions whose arguments the host parses itself rather than forwarding
 * to a handler that validates them (#13501). Each must take exactly the keys
 * its renderer action takes, so a call means the same with or without a view.
 */
describe("viewless argument schemas", () => {
  const schemas: Record<string, z.ZodType> = {
    ...VIEWLESS_FORGE_ARGS_SCHEMAS,
    "worktree.createWithRecipe": WorktreeCreateWithRecipeArgsSchema,
    "slashCommands.list": SlashCommandsListArgsSchema,
    "recipe.list": RecipeListArgsSchema,
    "agent.listPresets": AgentListPresetsArgsSchema,
    "agent.listModels": AgentListModelsArgsSchema,
    "worktree.waitForPullRequest": WorktreeWaitForPullRequestArgsSchema,
    "agentSessionHistory.list": AgentSessionHistoryListArgsSchema,
    "git.getProjectPulse": GitGetProjectPulseArgsSchema,
    "agent.launch": AgentLaunchArgsSchema,
    // Parsed in main before its create runs (#15738), so a key the renderer's
    // advertised schema gained would otherwise be refused there.
    "agent.launchInNewWorktree": AgentLaunchInNewWorktreeArgsSchema,
  };

  it.each(Object.entries(schemas))(
    "takes the keys %s's renderer action takes",
    async (id, schema) => {
      const registry = await createActionRegistry();
      const definition = registry.get(id as ActionId)?.();

      const rendererSchema: unknown = definition?.argsSchema;
      if (!isZodSchema(rendererSchema)) throw new Error(`${id} has no renderer args schema`);
      expect(acceptedKeys(schema)).toEqual(acceptedKeys(rendererSchema));
    }
  );

  it("takes the keys worktree.createWithRecipe's renderer action takes in every source mode", async () => {
    const registry = await createActionRegistry();
    const rendererSchema: unknown = registry.get("worktree.createWithRecipe")?.()?.argsSchema;
    if (!isZodSchema(rendererSchema)) throw new Error("createWithRecipe has no args schema");

    const rendererArms = sourceArmKeys(rendererSchema);
    expect(Object.keys(rendererArms).sort()).toEqual([
      "existingBranch",
      "newBranch",
      "pullRequest",
    ]);
    expect(sourceArmKeys(WorktreeCreateWithRecipeArgsSchema)).toEqual(rendererArms);
  });

  it("takes the source modes agent.launchInNewWorktree's renderer action advertises", async () => {
    const registry = await createActionRegistry();
    const rendererSchema: unknown = registry.get("agent.launchInNewWorktree")?.()?.argsSchema;
    if (!isZodSchema(rendererSchema)) throw new Error("launchInNewWorktree has no args schema");

    expect(sourceArmKeys(AgentLaunchInNewWorktreeArgsSchema)).toEqual(
      sourceArmKeys(rendererSchema)
    );
  });
});
