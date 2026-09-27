import fs from "node:fs/promises";
import path from "node:path";
import { parseProjectPluginInstanceKey } from "../../../shared/types/plugin.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

/**
 * A repository's own defaults for which of ITS plugins' agent endpoints are on,
 * read from `.daintree/mcp.json`:
 *
 * ```json
 * { "plugins": { "acme.ledger": ["@databases", "entries"], "acme.crm": "*" } }
 * ```
 *
 * Keyed by manifest id, so the file is portable across clones. A default only
 * ever reaches a project plugin of the same project: those load only after the
 * user trusts the project's plugins, which already lets their code run, so
 * exposing their tools to that project's agents asks nothing new. An installed
 * plugin is never switched on by a repository — that would let any clone read
 * the user's own plugin data through their agents. The user's answer in
 * Settings beats a default either way (`projectEnablement.ts`).
 */
export const PROJECT_MCP_DEFAULTS_FILE = [".daintree", "mcp.json"] as const;

const MAX_FILE_BYTES = 64 * 1024;
const MAX_ID_LENGTH = 128;

type EndpointSelection = "*" | ReadonlySet<string>;

export interface ProjectMcpDefaults {
  /** manifest id → the endpoint ids on by default, or `"*"` for every endpoint it declares. */
  plugins: ReadonlyMap<string, EndpointSelection>;
}

const EMPTY: ProjectMcpDefaults = { plugins: new Map() };

const cache = new Map<string, ProjectMcpDefaults>();
// One refresh per project wins: a read that started earlier and finished later
// must not put back what a newer read already replaced.
const generations = new Map<string, number>();

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

/** Lenient per entry: one malformed plugin entry drops that entry, not the file. */
export function parseProjectMcpDefaults(raw: unknown): ProjectMcpDefaults {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY;
  const plugins = (raw as Record<string, unknown>).plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return EMPTY;
  const result = new Map<string, EndpointSelection>();
  for (const [manifestId, selection] of Object.entries(plugins)) {
    if (!isId(manifestId)) continue;
    if (selection === "*" || selection === true) {
      result.set(manifestId, "*");
    } else if (Array.isArray(selection)) {
      const ids = new Set(selection.filter(isId));
      if (ids.size > 0) result.set(manifestId, ids);
    }
  }
  return { plugins: result };
}

async function readDefaultsFile(projectRoot: string): Promise<ProjectMcpDefaults> {
  const daintreeDir = path.join(projectRoot, PROJECT_MCP_DEFAULTS_FILE[0]);
  const filePath = path.join(projectRoot, ...PROJECT_MCP_DEFAULTS_FILE);
  try {
    // Refuse links at either level, as every other `.daintree/` reader does: a
    // link could point this at a file the repository does not own.
    const dirStat = await fs.lstat(daintreeDir);
    if (!dirStat.isDirectory()) return EMPTY;
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return EMPTY;
    let content = await fs.readFile(filePath, "utf-8");
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    return parseProjectMcpDefaults(JSON.parse(content));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      console.warn(
        `[AgentMcp] Ignoring ${PROJECT_MCP_DEFAULTS_FILE.join("/")} in ${projectRoot}:`,
        formatErrorMessage(err, "unreadable")
      );
    }
    return EMPTY;
  }
}

/**
 * Re-read a project's defaults. Called — through `refreshProjectAgentMcpDefaults`,
 * which also revokes what a removed default no longer allows — before every
 * agent launch and every settings read, so the synchronous checks below, made
 * per MCP request, answer from what the file last said.
 */
export async function refreshProjectMcpDefaults(
  projectId: string,
  projectRoot: string | null | undefined
): Promise<ProjectMcpDefaults> {
  const generation = (generations.get(projectId) ?? 0) + 1;
  generations.set(projectId, generation);
  const defaults = projectRoot ? await readDefaultsFile(projectRoot) : EMPTY;
  if (generations.get(projectId) !== generation) return getProjectMcpDefaults(projectId);
  if (defaults.plugins.size > 0) cache.set(projectId, defaults);
  else cache.delete(projectId);
  return defaults;
}

export function getProjectMcpDefaults(projectId: string): ProjectMcpDefaults {
  return cache.get(projectId) ?? EMPTY;
}

/** Whether the project's own file turns this endpoint on. Never true for an installed plugin. */
export function isProjectDefaultEndpoint(
  projectId: string,
  pluginInstanceId: string,
  endpointId: string
): boolean {
  const parsed = parseProjectPluginInstanceKey(pluginInstanceId);
  if (parsed === null || parsed.projectId !== projectId) return false;
  const selection = getProjectMcpDefaults(projectId).plugins.get(parsed.manifestId);
  if (selection === undefined) return false;
  return selection === "*" || selection.has(endpointId);
}

export function hasProjectMcpDefaults(projectId: string): boolean {
  return getProjectMcpDefaults(projectId).plugins.size > 0;
}

/** Test seam. */
export function _resetProjectMcpDefaultsForTests(): void {
  cache.clear();
  generations.clear();
}
