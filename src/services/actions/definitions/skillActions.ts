import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";

/**
 * Built-in `skills.search` / `skills.load` actions (#10892). These are
 * registered here purely for manifest registration — schema, description, tier,
 * and audit metadata. Execution is short-circuited in the MCP CallTool handler
 * (electron/services/mcp-server/sessionServer.ts) and runs against the
 * main-process skill registry, because the renderer holds no skill data (parsed
 * plugin markdown lives in main). `run()` throws if the renderer ever invokes
 * them directly. Skills are read-only knowledge tools → workbench tier.
 */
export function registerSkillActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("skills.search", () =>
    defineAction({
      id: "skills.search",
      title: "Search skills",
      description:
        "Search plugin-contributed skills — reusable markdown instructions/workflows (e.g. a TDD workflow, a review rubric) that plugins ship. Returns matching skills' ids, names, descriptions, and trigger phrases; call `skills.load` with an id to read the full body. Args: `query` (keywords matched against skill id/name/description/triggers; omit or pass empty to list all), `limit` (max results, default 20). Returns { skills }.",
      category: "agent",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z
        .object({
          query: z
            .string()
            .optional()
            .describe("Keywords to match. Omit or pass an empty string to list all skills."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe("Maximum number of matches to return (default 20, max 50)."),
        })
        .optional(),
      resultSchema: z.object({
        skills: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            description: z.string().nullable(),
            triggers: z.array(z.string()),
          })
        ),
      }),
      mcpAnnotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
      },
      run: async () => {
        throw new Error(
          "skills.search must be invoked through the MCP main-process path, not renderer dispatch."
        );
      },
    })
  );

  actions.set("skills.load", () =>
    defineAction({
      id: "skills.load",
      title: "Load skill",
      description:
        "Load the full markdown body of a plugin-contributed skill by its id (from `skills.search`), so its instructions can be incorporated into the current task. Args: `id` — the skill id, namespaced as `{pluginId}.{skillId}` (e.g. `daintree.hello.tdd-workflow`). Returns { id, name, description, body }. Errors if no skill matches the id.",
      category: "agent",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        id: z
          .string()
          .min(1)
          .describe("The skill id from `skills.search`, e.g. `daintree.hello.tdd-workflow`."),
      }),
      resultSchema: z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().nullable(),
        body: z.string(),
      }),
      mcpAnnotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
      },
      run: async () => {
        throw new Error(
          "skills.load must be invoked through the MCP main-process path, not renderer dispatch."
        );
      },
    })
  );
}
