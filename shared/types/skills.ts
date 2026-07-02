/**
 * Result shapes for the built-in MCP `skills.search` / `skills.load` tools
 * (#10892). Shared between the main-process skill registry (which produces
 * them) and the renderer action definitions (whose `resultSchema` mirrors them
 * for the MCP output schema). Skills are plugin-contributed markdown files —
 * see {@link import("./plugin.js").SkillContribution}.
 */

/** One entry returned by `skills.search` — metadata only, never the body. */
export interface SkillSearchMatch {
  /** Runtime-namespaced id, `{pluginId}.{skillId}`. */
  id: string;
  name: string;
  /** First-line summary from the skill file's frontmatter, or null when absent. */
  description: string | null;
  triggers: string[];
}

export interface SkillSearchResult {
  skills: SkillSearchMatch[];
}

/** Full skill returned by `skills.load` — includes the markdown body. */
export interface SkillLoadResult {
  id: string;
  name: string;
  description: string | null;
  /** The markdown body (everything after the frontmatter block). */
  body: string;
}
