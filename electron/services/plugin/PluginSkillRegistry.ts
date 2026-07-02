import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { load as parseYaml } from "js-yaml";
import { resolveContainedPath } from "./pluginFsContainment.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { SkillContribution } from "../../../shared/types/plugin.js";
import type {
  SkillSearchMatch,
  SkillSearchResult,
  SkillLoadResult,
} from "../../../shared/types/skills.js";

/**
 * Main-process registry for plugin-contributed skills (#10892). Skills are
 * markdown files a plugin ships (`contributes.skills`); Daintree's built-in MCP
 * server surfaces them to agents through the `skills.search` / `skills.load`
 * tools, executed against this registry in the main process (see the
 * short-circuit in `electron/services/mcp-server/sessionServer.ts`).
 *
 * The registry is a process singleton keyed by the runtime-namespaced id
 * `{pluginId}.{skillId}`, with a parallel per-plugin index so `unregisterPluginSkills`
 * can drop exactly one plugin's skills on unload/disable (scoped teardown — a
 * skill from plugin A must vanish from search results when A unloads without
 * touching plugin B). Skill files are read and parsed eagerly at registration
 * so `search` is filesystem-free and `load` returns a cached body; a malformed
 * or unreadable file is skipped with a warning rather than failing the whole
 * plugin load.
 */

/**
 * Cap on a skill markdown file's on-disk size. The whole file is read into
 * memory, cached, and (for `skills.load`) serialized into an MCP response, so an
 * unbounded file would let a manifest with up to `MANIFEST_CONTRIBUTION_CAPS.skills`
 * entries exhaust main-process memory or bloat a tool response. A file over the
 * cap is skipped with a warning (same policy as an unreadable/malformed file).
 * Generous for real instruction/rubric markdown.
 */
const MAX_SKILL_FILE_BYTES = 512 * 1024;
/** Cap on the frontmatter block we hand to the YAML parser (defense-in-depth). */
const FRONTMATTER_MAX_BYTES = 16 * 1024;
/** Default and maximum number of matches `skills.search` returns. */
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;

interface RegisteredSkill {
  /** `{pluginId}.{skillId}` */
  qualifiedId: string;
  pluginId: string;
  name: string;
  description: string | null;
  triggers: string[];
  body: string;
}

const skillsByQualifiedId = new Map<string, RegisteredSkill>();
const qualifiedIdsByPlugin = new Map<string, Set<string>>();

/**
 * Split a skill markdown file into its frontmatter-derived `description` and its
 * body. A leading `---\n ... \n---` block is parsed as YAML (Daintree's own
 * shape: `description`, optional `applies_to` / `examples`); only `description`
 * is surfaced in search results. A file with no frontmatter, an unterminated
 * block, or malformed YAML degrades to `description: null` and treats the whole
 * (or post-block) text as the body — a bad frontmatter never drops the skill.
 */
export function parseSkillMarkdown(raw: string): { description: string | null; body: string } {
  const normalized = raw.replace(/^\uFEFF/, "");
  // Match a leading `---` fenced block. The closing `---` must be its own full
  // line (`(?=\r?\n|$)`), so a body line like `---notclose` or a horizontal
  // rule is NOT mistaken for the fence. The frontmatter content is optional so
  // an empty block (`---\n---`) parses cleanly. Trailing blank line(s) between
  // the fence and the body are consumed, so the body starts at its first
  // content line.
  const match = normalized.match(
    /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?=\r?\n|$)(?:\r?\n)*/
  );
  if (!match) {
    return { description: null, body: normalized };
  }
  const frontmatter = match[1] ?? "";
  const body = normalized.slice(match[0].length);
  let description: string | null = null;
  if (Buffer.byteLength(frontmatter, "utf8") <= FRONTMATTER_MAX_BYTES) {
    try {
      const parsed = parseYaml(frontmatter);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const value = (parsed as Record<string, unknown>).description;
        if (typeof value === "string" && value.trim().length > 0) {
          description = value.trim();
        }
      }
    } catch {
      // Malformed YAML — leave description null and keep the body.
    }
  }
  return { description, body };
}

function indexSkill(skill: RegisteredSkill): void {
  skillsByQualifiedId.set(skill.qualifiedId, skill);
  let ids = qualifiedIdsByPlugin.get(skill.pluginId);
  if (!ids) {
    ids = new Set<string>();
    qualifiedIdsByPlugin.set(skill.pluginId, ids);
  }
  ids.add(skill.qualifiedId);
}

/**
 * Register a plugin's declared skills. Reads and parses each file eagerly,
 * realpath-containing the path to `pluginDir` (so a symlink under `skills/`
 * cannot escape the plugin dir at read time — the manifest grammar guard alone
 * doesn't cover that). Idempotent per plugin: any previously-registered skills
 * for `pluginId` are cleared first so a reload can't leave stale entries.
 */
export async function registerPluginSkills(
  pluginId: string,
  pluginDir: string,
  contributions: readonly SkillContribution[]
): Promise<void> {
  unregisterPluginSkills(pluginId);
  for (const contribution of contributions) {
    const qualifiedId = `${pluginId}.${contribution.id}`;
    try {
      const requested = path.resolve(pluginDir, contribution.path);
      const contained = await resolveContainedPath(pluginId, requested, [pluginDir]);
      const { size } = await stat(contained);
      if (size > MAX_SKILL_FILE_BYTES) {
        throw new Error(
          `skill file exceeds ${MAX_SKILL_FILE_BYTES} bytes (${size}) — skipped to bound memory`
        );
      }
      const raw = await readFile(contained, "utf8");
      const { description, body } = parseSkillMarkdown(raw);
      indexSkill({
        qualifiedId,
        pluginId,
        name: contribution.name,
        description,
        triggers: contribution.triggers ?? [],
        body,
      });
    } catch (err) {
      console.warn(
        `[PluginSkillRegistry] Skipping skill "${qualifiedId}" (${contribution.path}): ${formatErrorMessage(
          err,
          "could not read skill file"
        )}`
      );
    }
  }
}

/** Drop every skill registered by `pluginId`. Safe to call for an unknown id. */
export function unregisterPluginSkills(pluginId: string): void {
  const ids = qualifiedIdsByPlugin.get(pluginId);
  if (!ids) return;
  for (const qualifiedId of ids) {
    skillsByQualifiedId.delete(qualifiedId);
  }
  qualifiedIdsByPlugin.delete(pluginId);
}

/** Reset the whole registry (test isolation / full plugin-system teardown). */
export function clearPluginSkillRegistry(): void {
  skillsByQualifiedId.clear();
  qualifiedIdsByPlugin.clear();
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Keyword search over all registered skills (minimal first cut — token overlap,
 * no ranking/embeddings). Scores each skill by how many distinct query tokens
 * appear in its id/name/description/triggers, drops zero-score skills, and sorts
 * by score then id (stable/deterministic). An empty query lists all skills
 * (bounded by `limit`) so an agent can enumerate what's available.
 */
export function searchPluginSkills(args: { query?: string; limit?: number }): SkillSearchResult {
  const limit = Math.min(
    Math.max(Math.floor(args.limit ?? DEFAULT_SEARCH_LIMIT), 1),
    MAX_SEARCH_LIMIT
  );
  // Dedupe so a repeated query term (`"tdd tdd"`) can't overweight a skill.
  const queryTokens = [...new Set(tokenize(args.query ?? ""))];
  const all = [...skillsByQualifiedId.values()];

  const scored = all.map((skill) => {
    if (queryTokens.length === 0) return { skill, score: 0 };
    const haystack = new Set(
      tokenize(
        [skill.qualifiedId, skill.name, skill.description ?? "", ...skill.triggers].join(" ")
      )
    );
    let score = 0;
    for (const token of queryTokens) {
      if (haystack.has(token)) score += 1;
    }
    return { skill, score };
  });

  const filtered = queryTokens.length === 0 ? scored : scored.filter((entry) => entry.score > 0);
  filtered.sort(
    (a, b) => b.score - a.score || a.skill.qualifiedId.localeCompare(b.skill.qualifiedId)
  );

  const skills: SkillSearchMatch[] = filtered.slice(0, limit).map(({ skill }) => ({
    id: skill.qualifiedId,
    name: skill.name,
    description: skill.description,
    triggers: skill.triggers,
  }));
  return { skills };
}

/** Return a skill's full body by its `{pluginId}.{skillId}` id, or null if unknown. */
export function loadPluginSkill(id: string): SkillLoadResult | null {
  const skill = skillsByQualifiedId.get(id);
  if (!skill) return null;
  return {
    id: skill.qualifiedId,
    name: skill.name,
    description: skill.description,
    body: skill.body,
  };
}
