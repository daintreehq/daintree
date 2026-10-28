import { z } from "zod";
import { AGENT_MCP_MAX_TOOLS_PER_ENDPOINT } from "../../../../shared/types/plugin.js";
import { RESERVED_AGENT_MCP_TOOL_NAMES } from "../../../services/pluginAgentMcp/types.js";
import type { ManifestValidationContext } from "./context.js";
import type { ParsedPluginManifest } from "../manifestShape.js";

// A project database is a file in the repository, so it is disclosed
// and gated like any other project write — and it needs a project to
// resolve against, which an installed plugin does not have.
export function validateDatabases(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const { projectRuntime, capabilities } = context;
  manifest.contributes.databases.forEach((database, index) => {
    if (database.location === "project") {
      if (!projectRuntime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "databases", index, "location"],
          message:
            'a "project" database is available only to a "scope": "project" plugin or an "instanceMode": "project" package — a singleton installed plugin is bound to no project to put the file in. Use "location": "local".',
          params: { errorCode: "database_project_scope_only" },
        });
      } else if (!capabilities.has("fs:project-write")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "databases", index, "location"],
          message:
            'a "project" database writes into the repository and requires the "fs:project-write" capability to be declared in capabilities.',
          params: { errorCode: "database_project_write_required" },
        });
      }
    } else if (database.path !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "databases", index, "path"],
        message:
          'path applies only to a "project" database; a "local" database always lives in the plugin\'s own data directory.',
        params: { errorCode: "database_local_path_unsupported" },
      });
    }
  });

  // Every declared query is a tool on the plugin's one MCP server, beside
  // the host's own database tools, so names are unique across all of the
  // plugin's databases and the total stays inside the server's budget.
  const queryOwners = new Map<string, string>();
  let declaredQueries = 0;
  manifest.contributes.databases.forEach((database, index) => {
    (database.queries ?? []).forEach((query, queryIndex) => {
      declaredQueries += 1;
      const path = ["contributes", "databases", index, "queries", queryIndex, "name"];
      const owner = queryOwners.get(query.name);
      if (RESERVED_AGENT_MCP_TOOL_NAMES.has(query.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `query "${query.name}" takes the name of one of the host's database tools (${[...RESERVED_AGENT_MCP_TOOL_NAMES].join(", ")}), which share the plugin's MCP server`,
          params: { errorCode: "database_query_name_reserved" },
        });
      } else if (owner !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `query "${query.name}" is declared twice (first on database "${owner}"); query names are tool names on one MCP server, so each must be unique across the plugin's databases`,
          params: { errorCode: "database_query_name_duplicate" },
        });
      } else {
        queryOwners.set(query.name, database.id);
      }
      if (declaredQueries === AGENT_MCP_MAX_TOOLS_PER_ENDPOINT + 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `query "${query.name}" is past the limit: a plugin may declare at most ${AGENT_MCP_MAX_TOOLS_PER_ENDPOINT} database queries in all`,
          params: { errorCode: "database_query_limit" },
        });
      }
    });
  });
}
