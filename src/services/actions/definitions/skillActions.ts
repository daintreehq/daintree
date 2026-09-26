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
 * them directly. Skills are read-only knowledge tools in the `full` tool set.
 */
export function registerSkillActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  actions.set("skills.search", () =>
    defineAction({
      id: "skills.search",
      title: "Search skills",
      description:
        "Find plugin-contributed skills: reusable instructions and workflows, such as a review rubric or a TDD procedure. Returns names and summaries only; load one by id to read it. Without a query it lists skills up to the limit, never saying if more exist.",
      category: "agent",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z
        .object({
          query: z
            .string()
            .optional()
            .describe("Keywords. Omit or empty to list unfiltered, still bounded by the limit."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe("Max matches (default 20, max 50)."),
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
        "Read the full instructions of one plugin-contributed skill, to follow in the current task. Get the id from a skills search; ids are plugin-namespaced and not guessable. An unknown id fails.",
      category: "agent",
      kind: "query",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        id: z.string().min(1).describe("Skill id from a skills search."),
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
