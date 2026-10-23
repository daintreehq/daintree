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
 * all: at read only, that is a database plugin that declares no writes.
 */
export function coversDeclaredSurface(
  plugin: DeclaredAgentMcpPlugin,
  scope: AgentMcpToolScope
): boolean {
  return (
    (!plugin.hasDatabases || scope.databases) &&
    (plugin.hasDatabaseWrites !== true || scope.databaseWrites === true) &&
    (plugin.pluginEndpoint === undefined || scope.pluginEndpointId === plugin.pluginEndpoint.id)
  );
}

/** A manifest string made safe for one line of generated Markdown. */
function knowledgeLabel(value: string): string {
  return value.replace(/[\p{Cc}`]+/gu, " ").trim();
}

/** The line every file a plugin hands over opens with, so it reads as the plugin's wherever it is opened. */
function provenance(displayName: string, pluginId: string, key: string): string {
  return `> From the ${knowledgeLabel(displayName)} plugin (\`${knowledgeLabel(pluginId)}\`), about the tools on its \`${key}\` MCP server. Written by the plugin's author, not by the user.\n\n`;
}

export function pluginSkillName(key: string, skillId: string): string {
  return `${key}-${skillId}`.replace(/-+/g, "-");
}

class KnowledgeReader {
  private used = 0;
  private containRoot: string | undefined;

  constructor(
    private readonly instanceId: string,
    private readonly pluginDir: string
  ) {}

  async realDir(): Promise<string> {
    this.containRoot ??= await fs.realpath(this.pluginDir);
    return this.containRoot;
  }

  async read(absPath: string): Promise<string> {
    const contained = await resolveContainedPath(this.instanceId, absPath, [this.pluginDir]);
    const stats = await fs.stat(contained);
    if (!stats.isFile()) throw new Error(`${absPath} is not a regular file`);
    if (this.used + stats.size > PLUGIN_KNOWLEDGE_MAX_BYTES) throw this.overBudget();
    const text = await fs.readFile(contained, "utf8");
    this.used += Buffer.byteLength(text, "utf8");
    if (this.used > PLUGIN_KNOWLEDGE_MAX_BYTES) throw this.overBudget();
    return text;
  }

  private overBudget(): Error {
    return new Error(`it is more than ${PLUGIN_KNOWLEDGE_MAX_BYTES} bytes`);
  }
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
  const reader = new KnowledgeReader(record.instanceId, record.dir);
  const preamble = provenance(displayName, pluginId, key);
  const resolve = (relPath: string) => path.resolve(record.dir, relPath);

  const references = new Map<string, string>();
  let instructions: string | null = null;
  let instructionsFile: string | null = null;
  if (contribution.instructions !== undefined) {
    const text = (await reader.read(resolve(contribution.instructions))).trim();
    if (Buffer.byteLength(text, "utf8") <= PLUGIN_INSTRUCTIONS_INLINE_BYTES) {
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
  for (const skill of contribution.skills ?? []) {
    const name = pluginSkillName(key, skill.id);
    const root = await resolveContainedPath(record.instanceId, resolve(skill.path), [record.dir]);
    const walk = await collectSourceFiles(root, await reader.realDir());
    if (walk.unreadableDirs.length > 0) throw new Error(`${walk.unreadableDirs[0]} can't be read`);
    if (walk.truncated) throw new Error(`skill "${skill.id}" has too many files`);
    for (const escaped of walk.escapedLinks) {
      console.warn("[AssistantPluginKnowledge] Skipping a link that leaves the plugin:", escaped);
    }
    const files = new Map<string, string>();
    for (const [rel, abs] of walk.files) {
      // Markdown only: a skill's scripts would run in the Assistant's session.
      if (!rel.toLowerCase().endsWith(".md") || rel.split("/")[0] === "scripts") continue;
      const text = await reader.read(abs);
      files.set(rel, rel === "SKILL.md" ? namePluginSkillManifest(text, name, preamble) : text);
    }
    if (!files.has("SKILL.md")) throw new Error(`skill "${skill.id}" has no SKILL.md`);
    skills.set(name, files);
  }

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
