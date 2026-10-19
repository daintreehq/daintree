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
  VIEWLESS_FORGE_ARGS_SCHEMAS,
  WorktreeCreateWithRecipeArgsSchema,
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
});
