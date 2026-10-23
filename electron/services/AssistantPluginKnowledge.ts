import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AssistantKnowledgeContribution } from "../../shared/types/plugin.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import {
  collectSourceFiles,
  namePluginSkillManifest,
  PLUGIN_REFERENCE_ROOT,
  type AssistantPluginContent,
} from "./AssistantContentMirror.js";
import { readBoundedFile } from "./AssistantUserConfig.js";
import { resolveContainedPath } from "./plugin/pluginFsContainment.js";
import { resolveLaunchPlugins, type LaunchPlugin } from "./pluginAgentMcp/launchPlugins.js";
import type { AgentMcpToolScope, DeclaredAgentMcpPlugin } from "./pluginAgentMcp/types.js";

/**
 * Plugins' Markdown for the Daintree Assistant (#13828): which plugins'
 * `contributes.assistantKnowledge` a provision may hand over, read from the
 * plugin's own directory and shaped into files for the content mirror and
 * notes for the prompt. Nothing here decides access; it follows the same
 * selection the Assistant's launch uses to hand over plugin tools.
 */

/** Instructions inlined per plugin; longer ones are handed over whole as a file. */
export const PLUGIN_INSTRUCTIONS_INLINE_BYTES = 4 * 1024;
/** Everything one plugin may hand over. A plugin past it is left out, never cut short. */
export const PLUGIN_KNOWLEDGE_MAX_BYTES = 512 * 1024;
const INSTRUCTIONS_FILE = "instructions.md";

export interface AssistantPluginKnowledge {
  /** The plugin's MCP server key in this launch. */
  key: string;
  /** Identity for attribution, each made safe for one line of Markdown. */
  pluginId: string;
  displayName: string;
  version: string;
  /** Notes to inline, or null when there are none or they went to `instructionsFile`. */
  instructions: string | null;
  /** Session-relative path of instructions too long to inline. */
  instructionsFile: string | null;
  /** Skill names as the CLI lists them. */
  skills: string[];
  /** Session-relative paths of the plugin's reference files. */
  references: string[];
  content: AssistantPluginContent;
}

/**
 * Whether the Assistant was given everything the plugin declares. Its notes
 * may describe any of its tools, so they go only to an Assistant that has them
 * all: at read only, that is a database plugin that declares no writes, and
 * for a plugin with tool groups, every group it declares.
 */
export function coversDeclaredSurface(
  plugin: DeclaredAgentMcpPlugin,
  scope: AgentMcpToolScope
): boolean {
  const endpoint = plugin.pluginEndpoint;
  return (
    (!plugin.hasDatabases || scope.databases) &&
    (plugin.hasDatabaseWrites !== true || scope.databaseWrites === true) &&
    (endpoint === undefined ||
      (scope.pluginEndpointId === endpoint.id &&
        (endpoint.groups ?? []).every((group) =>
          (scope.pluginGroups ?? []).some(
            (granted) => granted.id === group.id && granted.access === group.access
          )
        )))
  );
}

const LABEL_MAX_CHARS = 120;

/** A manifest string made safe, and short enough, for one line of generated Markdown. */
function knowledgeLabel(value: string): string {
  return value
    .replace(/[\p{Cc}`]+/gu, " ")
    .trim()
    .slice(0, LABEL_MAX_CHARS);
}

/** The line every file a plugin hands over opens with, so it reads as the plugin's wherever it is opened. */
function provenance(displayName: string, pluginId: string, key: string): string {
  return `> From the ${knowledgeLabel(displayName)} plugin (\`${knowledgeLabel(pluginId)}\`), about the tools on its \`${key}\` MCP server. Written by the plugin's author, not by the user.\n\n`;
}

/**
 * Claude Code runs a skill's `!`command`` and its ```` ```! ```` fenced blocks
 * when the skill is invoked, and puts the output in their place. A plugin's
 * knowledge is text and never runs, so both forms are broken with a
 * zero-width space.
 */
export function neutralizeSkillShell(text: string): string {
  return text.replace(/!`/g, "!\u200B`").replace(/```([ \t]*)!/g, "```$1\u200B!");
}

export function pluginSkillName(key: string, skillId: string): string {
  return `${key}-${skillId}`.replace(/-+/g, "-");
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function overBudget(): Error {
  return new Error(`it is more than ${PLUGIN_KNOWLEDGE_MAX_BYTES} bytes`);
}

/** Reads a plugin's files against what is left of its budget, contained to its directory. */
class KnowledgeReader {
  private used = 0;

  constructor(private readonly pluginDir: string) {}

  async read(absPath: string): Promise<string> {
    const remaining = PLUGIN_KNOWLEDGE_MAX_BYTES - this.used;
    if (remaining <= 0) throw overBudget();
    // Opened by its real path without following a final link, with its type
    // and size taken from the handle, so a swap after the containment check
    // can neither leave the plugin nor slip past the budget.
    const text = await readBoundedFile(absPath, remaining, this.pluginDir);
    if (text === null) throw new Error(`${absPath} doesn't exist`);
    this.used += byteLength(text);
    return text;
  }
}

// A skill's own `scripts/` is never mirrored, so it is not walked either: its
// size, depth or readability can't cost the plugin its knowledge.
function isSkillScriptsDir(rel: string): boolean {
  return rel.toLowerCase() === "scripts";
}

/**
 * Reads one plugin's knowledge whole, or throws: a part that can't be read,
 * escapes the plugin directory, or breaks the budget leaves out the plugin, so
 * the prompt never points at half of it.
 */
export async function readPluginKnowledge(
  launch: Pick<LaunchPlugin, "record" | "serverKey">,
  contribution: AssistantKnowledgeContribution
): Promise<AssistantPluginKnowledge> {
  const { record, serverKey: key } = launch;
  const pluginId = record.manifest.name;
  const displayName = record.manifest.displayName ?? record.manifest.name;
  const reader = new KnowledgeReader(record.dir);
  const preamble = provenance(displayName, pluginId, key);
  const resolve = (relPath: string) => path.resolve(record.dir, relPath);

  const references = new Map<string, string>();
  let instructions: string | null = null;
  let instructionsFile: string | null = null;
  if (contribution.instructions !== undefined) {
    const text = (await reader.read(resolve(contribution.instructions))).trim();
    if (byteLength(text) <= PLUGIN_INSTRUCTIONS_INLINE_BYTES) {
      instructions = text.length > 0 ? text : null;
    } else {
      references.set(INSTRUCTIONS_FILE, `${preamble}${text}\n`);
      instructionsFile = `${PLUGIN_REFERENCE_ROOT}/${key}/${INSTRUCTIONS_FILE}`;
    }
  }
  for (const reference of contribution.references ?? []) {
    references.set(
      `${reference.id}.md`,
      `${preamble}${await reader.read(resolve(reference.path))}`
    );
  }

  const skills = new Map<string, ReadonlyMap<string, string>>();
  const realPluginDir = await fs.realpath(record.dir);
  for (const skill of contribution.skills ?? []) {
    const name = pluginSkillName(key, skill.id);
    const root = await resolveContainedPath(record.instanceId, resolve(skill.path), [record.dir]);
    const walk = await collectSourceFiles(root, realPluginDir, isSkillScriptsDir);
    if (walk.unreadableDirs.length > 0) throw new Error(`${walk.unreadableDirs[0]} can't be read`);
    if (walk.truncated) throw new Error(`skill "${skill.id}" has too many files`);
    for (const escaped of walk.escapedLinks) {
      console.warn("[AssistantPluginKnowledge] Skipping a link that leaves the plugin:", escaped);
    }
    const files = new Map<string, string>();
    for (const [rel, abs] of walk.files) {
      // Markdown only: anything else a skill bundles is a script or an asset.
      if (!rel.toLowerCase().endsWith(".md")) continue;
      const text = await reader.read(abs);
      files.set(
        rel,
        neutralizeSkillShell(
          rel === "SKILL.md" ? namePluginSkillManifest(text, name, preamble) : text
        )
      );
    }
    if (!files.has("SKILL.md")) throw new Error(`skill "${skill.id}" has no SKILL.md`);
    skills.set(name, files);
  }

  // The budget holds for what is handed over, provenance lines included, not
  // only for what was read.
  let total = byteLength(instructions ?? "");
  for (const text of references.values()) total += byteLength(text);
  for (const files of skills.values()) {
    for (const text of files.values()) total += byteLength(text);
  }
  if (total > PLUGIN_KNOWLEDGE_MAX_BYTES) throw overBudget();

  return {
    key,
    pluginId: knowledgeLabel(pluginId),
    displayName: knowledgeLabel(displayName),
    version: knowledgeLabel(record.manifest.version),
    instructions,
    instructionsFile,
    skills: [...skills.keys()],
    references: [...references.keys()]
      .filter((rel) => rel !== INSTRUCTIONS_FILE)
      .map((rel) => `${PLUGIN_REFERENCE_ROOT}/${key}/${rel}`),
    content: { key, skills, references },
  };
}

/**
 * The knowledge of every plugin the project's Assistant launch would be handed
 * the whole of. Never throws: a plugin that can't be read is left out with a
 * warning, and a failed selection hands over none.
 */
export async function resolveAssistantPluginKnowledge(input: {
  projectId: string;
  projectPath: string;
}): Promise<AssistantPluginKnowledge[]> {
  let launches: LaunchPlugin[];
  try {
    launches = await resolveLaunchPlugins(input.projectId, input.projectPath, "assistant");
  } catch (err) {
    console.warn("[AssistantPluginKnowledge] Couldn't list the Assistant's plugins:", err);
    return [];
  }
  const knowledge: AssistantPluginKnowledge[] = [];
  for (const launch of launches) {
    const contribution = launch.record.manifest.contributes.assistantKnowledge;
    if (!contribution || !coversDeclaredSurface(launch.plugin, launch.scope)) continue;
    try {
      knowledge.push(await readPluginKnowledge(launch, contribution));
    } catch (err) {
      console.warn(
        `[AssistantPluginKnowledge] Leaving out ${launch.plugin.pluginInstanceId}'s Assistant knowledge: ${formatErrorMessage(err, "it couldn't be read")}`
      );
    }
  }
  return knowledge;
}
