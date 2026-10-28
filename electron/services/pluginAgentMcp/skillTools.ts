import type { SkillLoadResult, SkillSearchResult } from "../../../shared/types/skills.js";
import {
  hasPluginSkills,
  loadPluginSkill,
  MAX_SKILL_SEARCH_LIMIT,
  searchPluginSkills,
  type SkillVisibility,
} from "../plugin/PluginSkillRegistry.js";
import type { AgentMcpRegisteredTool, AgentMcpToolDescriptor } from "./types.js";
import { compileAgentMcpTool } from "./validateTools.js";

/**
 * The host's skill tools on a plugin's own agent MCP server (#13831): the
 * plugin's `contributes.skills`, served beside the tools they teach, to exactly
 * the sessions its grant admits. Named as on Daintree's own server so agents
 * meet one vocabulary; the dot puts them outside the plugin tool-name grammar,
 * so no roster can register either name.
 */
export const SKILL_SEARCH_TOOL = "skills.search";
export const SKILL_LOAD_TOOL = "skills.load";

export const SKILL_TOOL_NAMES: ReadonlySet<string> = new Set([SKILL_SEARCH_TOOL, SKILL_LOAD_TOOL]);

/** Longest unknown skill id echoed back in the "no skill found" error. */
const MAX_ECHOED_SKILL_ID_LENGTH = 128;

/** Where a plugin session reads skills from. The registry, except in tests. */
export interface PluginSkillSource {
  has(pluginInstanceId: string): boolean;
  search(args: { query?: string; limit?: number }, visibility: SkillVisibility): SkillSearchResult;
  load(id: string, visibility: SkillVisibility): SkillLoadResult | null;
}

export const pluginSkillRegistrySource: PluginSkillSource = {
  has: hasPluginSkills,
  search: searchPluginSkills,
  load: loadPluginSkill,
};

const SKILL_TOOL_DESCRIPTORS: readonly AgentMcpToolDescriptor[] = [
  {
    name: SKILL_SEARCH_TOOL,
    readOnly: true,
    description:
      "Find this plugin's skills: instructions it ships for working with its tools and data, such as a workflow or a rubric. Returns names and summaries only; load one by id to read it. Without a query it lists skills up to the limit, never saying if more exist.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: MAX_SKILL_SEARCH_LIMIT },
      },
    },
    outputSchema: {
      type: "object",
      required: ["skills"],
      properties: {
        skills: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "name", "description", "triggers"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              description: { type: ["string", "null"] },
              triggers: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
  },
  {
    name: SKILL_LOAD_TOOL,
    readOnly: true,
    description:
      "Read the full instructions of one of this plugin's skills, to follow in the current task. Get the id from a skills search; an unknown id fails.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string", minLength: 1 } },
    },
    outputSchema: {
      type: "object",
      required: ["id", "name", "description", "body"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        description: { type: ["string", "null"] },
        body: { type: "string" },
      },
    },
  },
];

let compiledTools: readonly AgentMcpRegisteredTool[] | undefined;

export function skillTools(): readonly AgentMcpRegisteredTool[] {
  compiledTools ??= Object.freeze(SKILL_TOOL_DESCRIPTORS.map(compileAgentMcpTool));
  return compiledTools;
}

/**
 * Answer one skill tool call whose arguments already passed its input schema.
 * Throws for an id the caller cannot see, worded the same whether the skill
 * does not exist or belongs to another plugin or project.
 */
export function runSkillTool(
  source: PluginSkillSource,
  toolName: string,
  args: Record<string, unknown>,
  visibility: SkillVisibility
): SkillSearchResult | SkillLoadResult {
  if (toolName === SKILL_SEARCH_TOOL) {
    return source.search(
      {
        ...(typeof args.query === "string" ? { query: args.query } : {}),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      },
      visibility
    );
  }
  const id = String(args.id).trim();
  const skill = id === "" ? null : source.load(id, visibility);
  if (skill === null) {
    const echoed =
      id.length > MAX_ECHOED_SKILL_ID_LENGTH ? `${id.slice(0, MAX_ECHOED_SKILL_ID_LENGTH)}…` : id;
    throw new Error(
      `No skill found with id "${echoed}". Use skills.search to discover available skill ids.`
    );
  }
  return skill;
}
