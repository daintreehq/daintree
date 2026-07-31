import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { searchPluginSkills, loadPluginSkill } from "../plugin/PluginSkillRegistry.js";
import type { SkillSearchResult, SkillLoadResult } from "../../../shared/types/skills.js";

/**
 * Main-process execution for the built-in `skills.search` / `skills.load` MCP
 * tools (#10892). The tools' manifest entries (schema, tier, audit metadata)
 * are registered in the renderer as ordinary query actions, but execution is
 * short-circuited here in the main process because the skill registry — parsed
 * plugin markdown — only exists in main. Mirrors the `terminal.waitUntilIdle`
 * pattern (`waitUntilIdle.ts`). Both handlers are synchronous reads against the
 * in-memory registry; they throw {@link McpError} for invalid args or an
 * unknown skill so the session server maps them to a clean tool error.
 */

/** Longest unknown skill id echoed back in the "no skill found" error. */
const MAX_ECHOED_SKILL_ID_LENGTH = 128;

function asArgsObject(rawArgs: unknown): Record<string, unknown> {
  if (rawArgs === undefined || rawArgs === null) return {};
  if (typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    return rawArgs as Record<string, unknown>;
  }
  throw new McpError(ErrorCode.InvalidParams, "skills tool arguments must be an object.");
}

export function handleSkillsSearch(rawArgs: unknown): SkillSearchResult {
  const args = asArgsObject(rawArgs);

  const queryRaw = args["query"];
  if (queryRaw !== undefined && typeof queryRaw !== "string") {
    throw new McpError(ErrorCode.InvalidParams, "skills.search `query` must be a string.");
  }

  const limitRaw = args["limit"];
  let limit: number | undefined;
  if (limitRaw !== undefined) {
    if (typeof limitRaw !== "number" || !Number.isFinite(limitRaw) || limitRaw < 1) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "skills.search `limit` must be a positive number."
      );
    }
    limit = limitRaw;
  }

  return searchPluginSkills({ query: queryRaw, limit });
}

export function handleSkillsLoad(rawArgs: unknown): SkillLoadResult {
  const args = asArgsObject(rawArgs);

  const idRaw = args["id"];
  if (typeof idRaw !== "string" || idRaw.trim() === "") {
    throw new McpError(ErrorCode.InvalidParams, "skills.load requires a non-empty `id` string.");
  }
  const id = idRaw.trim();

  const skill = loadPluginSkill(id);
  if (!skill) {
    // Clamp the echoed id: this message becomes a JSON-RPC error, which bypasses
    // the `tools/call` response budget entirely, so reflecting the argument
    // verbatim would let a megabyte-long id produce a megabyte-long error
    // (#11526). Real skill ids are far shorter than this.
    const echoed = id.length > MAX_ECHOED_SKILL_ID_LENGTH
      ? `${id.slice(0, MAX_ECHOED_SKILL_ID_LENGTH)}…`
      : id;
    throw new McpError(
      ErrorCode.InvalidParams,
      `No skill found with id "${echoed}". Use skills.search to discover available skill ids.`
    );
  }
  return skill;
}
