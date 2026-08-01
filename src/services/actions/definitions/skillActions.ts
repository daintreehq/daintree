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
        "Find plugin-contributed skills: reusable written instructions and workflows, such as a review rubric or a test-driven-development procedure, that plugins ship for an agent to follow. This returns names and summaries only; load a skill by id to read its actual instructions. Omitting a query lists available skills, but only up to the capped result limit, and the result never says whether more were left out.",
      category: "agent",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z
        .object({
          query: z
            .string()
            .optional()
            .describe(
              "Keywords to match. Omit or pass an empty string to list skills unfiltered, still bounded by the result limit."
            ),
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
        "Read the full instructions of one plugin-contributed skill, so they can be followed as part of the current task. Find the id with a skills search first — ids are namespaced by plugin and cannot be guessed reliably. An id that matches nothing fails rather than returning empty.",
      category: "agent",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        id: z
          .string()
          .min(1)
          .describe(
            "Identifies the skill to load, using an id from a skills search. Ids are namespaced by the contributing plugin and cannot be guessed reliably."
          ),
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
