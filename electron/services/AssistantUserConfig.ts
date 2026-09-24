import { constants as fsConstants, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  getGlobalAssistantContentDir,
  getProjectAssistantContentDir,
} from "./AssistantContentMirror.js";

/**
 * Reads the assistant-folder content that is NOT mirrored as files: free-form
 * instructions (both scopes) and the executable config lane (global scope
 * only, behind the `loadGlobalHooksAndServers` opt-in).
 *
 * The split is a trust boundary. `<project>/.daintree/assistant` is committed
 * to the repository, so it is written by whoever authored the repo — it may
 * add text the model reads (skills, instructions, reference files), never
 * anything that runs code. `~/.daintree/assistant` is written only by the
 * user, so MCP servers (which spawn processes) and Claude hooks (which run
 * shell commands) are accepted from there, and only once the user turns the
 * setting on. Nothing here can replace Daintree's own session files: the
 * instructions are appended in a managed block, MCP servers merge beside
 * Daintree's (whose names are reserved), and hooks are the only settings key
 * a user file may contribute.
 */

export const INSTRUCTIONS_FILE = "instructions.md";
export const MCP_CONFIG_FILE = "mcp.json";
export const HOOKS_CONFIG_FILE = "hooks.json";

const MAX_INSTRUCTIONS_BYTES = 64 * 1024;
const MAX_CONFIG_BYTES = 256 * 1024;

// Daintree's own server names. A user entry must never shadow them: the
// `daintree` entry carries the session bearer and the tier boundary.
const RESERVED_MCP_SERVER_NAMES = new Set(["daintree", "daintree-docs"]);

// Bare-key safe (TOML `-c mcp_servers.<name>.…` for Codex) and a valid Claude
// tool-name prefix (`mcp__<name>__*`).
const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// HTTP header names are RFC 7230 tokens.
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;

export type AssistantUserMcpServer =
  | {
      type: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
    }
  | {
      type: "http" | "sse";
      url: string;
      headers: Record<string, string>;
    };

export interface AssistantUserInstructions {
  scope: "global" | "project";
  /** Where the user edits it — shown to the model so it can cite the source. */
  displayPath: string;
  content: string;
}

export interface AssistantUserConfig {
  instructions: AssistantUserInstructions[];
  /** Empty unless the opt-in is on and ~/.daintree/assistant/mcp.json is valid. */
  mcpServers: Record<string, AssistantUserMcpServer>;
  /** Claude settings `hooks` object; null unless the opt-in is on and hooks.json exists. */
  claudeHooks: Record<string, unknown> | null;
  /** Human-readable reasons content was skipped; logged by the caller. */
  warnings: string[];
}

export interface LoadAssistantUserConfigInput {
  projectPath: string;
  /** Hooks are read only for `claude`; other agents never load them. */
  agentId: string;
  loadGlobalHooksAndServers: boolean;
  /** Test seam — defaults to ~/.daintree/assistant. */
  globalContentDir?: string;
}

function isAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// JSON parses these as prototype setters on a plain object, so an entry by
// this name would vanish instead of being validated.
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Codex CLI arguments travel through the launch shell, and Windows caps a
// whole command line at 32,767 UTF-16 units. The launch path quotes every
// argument and may carry the command as Base64 UTF-16LE (~2.7x), so the user
// servers' share is budgeted well below the cap, with characters that grow
// when escaped or encoded weighted accordingly. An estimate, not a
// measurement of the final command line.
const CODEX_USER_ARGS_BUDGET_UNITS = 6 * 1024;

function launchWeight(arg: string): number {
  let weight = 3; // separator and surrounding quotes
  for (const ch of arg) {
    weight += ch.length > 1 || `'"\`$\\`.includes(ch) ? 2 : 1;
  }
  return weight;
}

// A user server named `foo` reaches Codex as `assistant-foo`: `-c` overrides
// are per key, so reusing a name from the user's own Codex config would
// inherit whatever fields this entry doesn't set — including its
// `bearer_token_env_var`, which would then be sent to this server's URL.
export const CODEX_USER_SERVER_PREFIX = "assistant-";

// Lone surrogates can't be encoded as UTF-8 or TOML.
const LONE_SURROGATE = /\p{Cs}/u;

function isWellFormed(value: string): boolean {
  return !LONE_SURROGATE.test(value);
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Reads a small text file. Missing → null. Present but unreadable, oversized,
 * not a regular file, or not valid UTF-8 → throws: the desired state can't be
 * proven, so the caller fails the provision closed rather than launching with
 * a session that silently lacks content the user wrote (a hook or instruction
 * may be a guard). A leading UTF-8 BOM is dropped.
 *
 * The file is opened by its resolved real path without following a final
 * symlink, and size and type come from that handle — so swapping the path
 * after the checks can't redirect the read or slip past the size cap.
 */
async function readBoundedFile(
  filePath: string,
  maxBytes: number,
  containWithin?: string
): Promise<string | null> {
  let real: string;
  try {
    real = await fs.realpath(filePath);
  } catch (err) {
    if (isAbsent(err)) return null;
    throw new Error(`Couldn't read ${filePath}`, { cause: err });
  }
  if (containWithin) {
    // A repository could otherwise symlink instructions.md at a file outside
    // itself (a key, a token file) and have it inlined into the prompt that is
    // sent to the model provider.
    const root = await fs.realpath(containWithin);
    if (real !== root && !real.startsWith(root + path.sep)) {
      throw new Error(`${filePath} links outside the project (${real})`);
    }
  }
  let handle;
  try {
    handle = await fs.open(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (err) {
    if (isAbsent(err)) return null;
    throw new Error(`Couldn't read ${filePath}`, { cause: err });
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${filePath} is not a regular file`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, length, maxBytes + 1 - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) {
      throw new Error(`${filePath} is larger than the ${maxBytes}-byte limit`);
    }
    try {
      return utf8.decode(buffer.subarray(0, length));
    } catch {
      throw new Error(`${filePath} isn't valid UTF-8`);
    }
  } finally {
    await handle.close();
  }
}

function readStringMap(
  value: unknown,
  keyPattern: RegExp,
  label: string,
  warnings: string[],
  rejectLineBreaks: boolean
): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    warnings.push(`${label} must be an object of strings`);
    return null;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      FORBIDDEN_KEYS.has(key) ||
      !keyPattern.test(key) ||
      typeof entry !== "string" ||
      !isWellFormed(entry) ||
      (rejectLineBreaks && /[\r\n\0]/.test(entry))
    ) {
      warnings.push(`${label} has an invalid entry "${key}"`);
      return null;
    }
    out[key] = entry;
  }
  return out;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}

function parseMcpServer(
  name: string,
  raw: unknown,
  warnings: string[]
): AssistantUserMcpServer | null {
  const label = `mcp.json server "${name}"`;
  if (!isPlainObject(raw)) {
    warnings.push(`${label} is not an object`);
    return null;
  }
  const type = raw.type ?? (typeof raw.url === "string" ? "http" : "stdio");
  if (type === "stdio") {
    if (
      typeof raw.command !== "string" ||
      raw.command.trim() === "" ||
      !isWellFormed(raw.command)
    ) {
      warnings.push(`${label} needs a "command"`);
      return null;
    }
    const args = raw.args ?? [];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || !isWellFormed(arg))) {
      warnings.push(`${label} "args" must be an array of strings`);
      return null;
    }
    const env = readStringMap(raw.env, ENV_KEY_PATTERN, `${label} "env"`, warnings, false);
    if (!env) return null;
    if (raw.cwd !== undefined && (typeof raw.cwd !== "string" || !isWellFormed(raw.cwd))) {
      warnings.push(`${label} "cwd" must be a string`);
      return null;
    }
    return {
      type: "stdio",
      command: raw.command,
      args: args as string[],
      env,
      ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
    };
  }
  if (type === "http" || type === "sse") {
    if (typeof raw.url !== "string" || !isWellFormed(raw.url) || !isHttpUrl(raw.url)) {
      warnings.push(`${label} needs an http(s) "url"`);
      return null;
    }
    const headers = readStringMap(
      raw.headers,
      HEADER_NAME_PATTERN,
      `${label} "headers"`,
      warnings,
      true
    );
    if (!headers) return null;
    return { type, url: raw.url, headers };
  }
  warnings.push(`${label} has unsupported type "${String(type)}"`);
  return null;
}

/**
 * MCP servers are an additive convenience: a bad entry is dropped with a
 * warning and the assistant still launches with Daintree's own servers.
 */
function parseMcpConfig(raw: string, warnings: string[]): Record<string, AssistantUserMcpServer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnings.push("mcp.json is not valid JSON; no user MCP servers were added");
    return {};
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.mcpServers)) {
    warnings.push('mcp.json needs a top-level "mcpServers" object; no user MCP servers were added');
    return {};
  }
  const servers: Record<string, AssistantUserMcpServer> = {};
  for (const [name, entry] of Object.entries(parsed.mcpServers)) {
    if (FORBIDDEN_KEYS.has(name) || !MCP_SERVER_NAME_PATTERN.test(name)) {
      warnings.push(`mcp.json server name "${name}" must be letters, digits, "-" or "_"`);
      continue;
    }
    if (RESERVED_MCP_SERVER_NAMES.has(name.toLowerCase())) {
      warnings.push(`mcp.json server name "${name}" is reserved by Daintree`);
      continue;
    }
    const server = parseMcpServer(name, entry, warnings);
    if (server) servers[name] = server;
  }
  return servers;
}

function checkOptional(
  hook: Record<string, unknown>,
  field: string,
  kind: "string" | "boolean" | "number",
  where: string
): void {
  const value = hook[field];
  if (value === undefined) return;
  const ok =
    kind === "number"
      ? typeof value === "number" && Number.isFinite(value) && value > 0
      : typeof value === kind;
  if (!ok) {
    throw new Error(`${where}.${field} must be a ${kind === "number" ? "positive number" : kind}`);
  }
}

// The handler types Claude Code accepts, and the field each one requires.
// An unknown type is rejected rather than passed through: Claude would reject
// the whole settings file over it, taking Daintree's deny rules with it.
const HOOK_REQUIRED_FIELD: Record<string, string> = {
  command: "command",
  prompt: "prompt",
  agent: "prompt",
  http: "url",
};

/**
 * Hooks can be guards (block a command, redact output), so a hooks.json the
 * user opted into that can't be parsed fails the provision closed instead of
 * launching a session without the guard.
 */
function parseHooksConfig(raw: string, filePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${filePath} is not valid JSON`, { cause: err });
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.hooks)) {
    throw new Error(`${filePath} needs a top-level "hooks" object`);
  }
  // Claude rejects the WHOLE settings file over one malformed hook, and that
  // file also carries Daintree's deny rules — so the shape is checked here and
  // a bad entry blocks the launch instead of silently dropping them.
  for (const [event, matchers] of Object.entries(parsed.hooks)) {
    if (!Array.isArray(matchers)) {
      throw new Error(`${filePath}: hooks.${event} must be an array`);
    }
    matchers.forEach((group: unknown, i) => {
      const where = `${filePath}: hooks.${event}[${i}]`;
      if (!isPlainObject(group)) throw new Error(`${where} must be an object`);
      if (group.matcher !== undefined && typeof group.matcher !== "string") {
        throw new Error(`${where}.matcher must be a string`);
      }
      if (!Array.isArray(group.hooks) || group.hooks.length === 0) {
        throw new Error(`${where}.hooks must be a non-empty array`);
      }
      group.hooks.forEach((hook: unknown, j) => {
        const hookWhere = `${where}.hooks[${j}]`;
        if (!isPlainObject(hook) || typeof hook.type !== "string") {
          throw new Error(`${hookWhere} needs a string "type"`);
        }
        const required = HOOK_REQUIRED_FIELD[hook.type];
        if (!required) {
          throw new Error(
            `${hookWhere}.type "${hook.type}" isn't one of ${Object.keys(HOOK_REQUIRED_FIELD).join(", ")}`
          );
        }
        if (typeof hook[required] !== "string" || hook[required] === "") {
          throw new Error(`${hookWhere} needs a string "${required}"`);
        }
        if (hook.type === "http" && !isHttpUrl(hook.url as string)) {
          throw new Error(`${hookWhere}.url must be an http(s) URL`);
        }
        if (hook.headers !== undefined) {
          if (
            !isPlainObject(hook.headers) ||
            Object.values(hook.headers).some((value) => typeof value !== "string")
          ) {
            throw new Error(`${hookWhere}.headers must be an object of strings`);
          }
        }
        if (
          hook.allowedEnvVars !== undefined &&
          (!Array.isArray(hook.allowedEnvVars) ||
            hook.allowedEnvVars.some((name) => typeof name !== "string"))
        ) {
          throw new Error(`${hookWhere}.allowedEnvVars must be an array of strings`);
        }
        checkOptional(hook, "timeout", "number", hookWhere);
        checkOptional(hook, "async", "boolean", hookWhere);
        checkOptional(hook, "statusMessage", "string", hookWhere);
        checkOptional(hook, "model", "string", hookWhere);
      });
    });
  }
  return parsed.hooks;
}

export async function loadAssistantUserConfig(
  input: LoadAssistantUserConfigInput
): Promise<AssistantUserConfig> {
  const globalDir = input.globalContentDir ?? getGlobalAssistantContentDir();
  const projectDir = getProjectAssistantContentDir(input.projectPath);
  const warnings: string[] = [];

  const instructions: AssistantUserInstructions[] = [];
  const globalInstructions = await readBoundedFile(
    path.join(globalDir, INSTRUCTIONS_FILE),
    MAX_INSTRUCTIONS_BYTES
  );
  if (globalInstructions?.trim()) {
    instructions.push({
      scope: "global",
      displayPath: `~/.daintree/assistant/${INSTRUCTIONS_FILE}`,
      content: globalInstructions.trim(),
    });
  }
  const projectInstructions = await readBoundedFile(
    path.join(projectDir, INSTRUCTIONS_FILE),
    MAX_INSTRUCTIONS_BYTES,
    input.projectPath
  );
  if (projectInstructions?.trim()) {
    instructions.push({
      scope: "project",
      displayPath: `.daintree/assistant/${INSTRUCTIONS_FILE}`,
      content: projectInstructions.trim(),
    });
  }

  // Project scope never contributes executable config, opt-in or not. Say so
  // in the log, since a team that commits one will otherwise wonder why it
  // does nothing.
  for (const file of [MCP_CONFIG_FILE, HOOKS_CONFIG_FILE]) {
    try {
      await fs.lstat(path.join(projectDir, file));
      warnings.push(
        `Ignored .daintree/assistant/${file} in the project: MCP servers and hooks load only from ~/.daintree/assistant`
      );
    } catch {
      // absent — nothing to report
    }
  }

  let mcpServers: Record<string, AssistantUserMcpServer> = {};
  let claudeHooks: Record<string, unknown> | null = null;
  if (input.loadGlobalHooksAndServers) {
    const mcpPath = path.join(globalDir, MCP_CONFIG_FILE);
    const mcpRaw = await readBoundedFile(mcpPath, MAX_CONFIG_BYTES);
    if (mcpRaw !== null) mcpServers = parseMcpConfig(mcpRaw, warnings);
    // Hooks are Claude's alone. Other agents never read the file, so a broken
    // one must not block their launch — the session's leftover hooks are
    // stripped separately for them.
    const hooksPath = path.join(globalDir, HOOKS_CONFIG_FILE);
    if (input.agentId === "claude") {
      const hooksRaw = await readBoundedFile(hooksPath, MAX_CONFIG_BYTES);
      if (hooksRaw !== null) claudeHooks = parseHooksConfig(hooksRaw, hooksPath);
    } else {
      try {
        await fs.lstat(hooksPath);
        warnings.push(`hooks.json is for Claude Code; ${input.agentId} sessions don't load it`);
      } catch {
        // absent — nothing to report
      }
    }
  }

  return { instructions, mcpServers, claudeHooks, warnings };
}

/** Claude / Copilot `mcpServers` entry shape. */
export function toJsonMcpServerEntry(server: AssistantUserMcpServer): Record<string, unknown> {
  if (server.type === "stdio") {
    return {
      type: "stdio",
      command: server.command,
      args: server.args,
      env: server.env,
      ...(server.cwd ? { cwd: server.cwd } : {}),
    };
  }
  return { type: server.type, url: server.url, headers: server.headers };
}

const TOML_ESCAPES: Record<string, string> = {
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\f": "\\f",
  "\r": "\\r",
  '"': '\\"',
  "\\": "\\\\",
};

/**
 * A TOML basic string. Every control character (U+0000–U+001F and U+007F) is
 * escaped, as TOML requires; the parser has already rejected lone surrogates.
 */
export function tomlString(value: string): string {
  // eslint-disable-next-line no-control-regex
  const escaped = value.replace(/[\u0000-\u001f\u007f"\\]/g, (ch) => {
    return TOML_ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
  return `"${escaped}"`;
}

function tomlInlineTable(map: Record<string, string>): string {
  const entries = Object.entries(map).map(
    ([key, value]) => `${tomlString(key)}=${tomlString(value)}`
  );
  return `{${entries.join(",")}}`;
}

/**
 * Names of the MCP servers in the user's own Codex config, read passively so a
 * user server is never layered onto one of them. Missing config → empty set;
 * present but unreadable or unparseable → null, meaning collisions can't be
 * ruled out.
 */
export async function readCodexNativeServerNames(
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
): Promise<Set<string> | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(codexHome, "config.toml"), "utf-8");
  } catch (err) {
    return isAbsent(err) ? new Set() : null;
  }
  try {
    const parsed = parseToml(raw) as Record<string, unknown>;
    return new Set(isPlainObject(parsed.mcp_servers) ? Object.keys(parsed.mcp_servers) : []);
  } catch {
    return null;
  }
}

/**
 * Codex takes MCP servers as `-c mcp_servers.<name>.<key>=<toml>` overrides —
 * it reads no project config from the session cwd. Each server is renamed
 * with `CODEX_USER_SERVER_PREFIX` so it never merges into a same-named entry
 * from the user's own Codex config. Codex has no SSE transport, so SSE
 * entries are skipped, as is any server that would push the arguments past
 * the launch-line budget.
 */
export function toCodexMcpServerArgs(
  servers: Record<string, AssistantUserMcpServer>,
  warnings: string[],
  nativeServerNames: Set<string> | null = new Set()
): string[] {
  const args: string[] = [];
  if (Object.keys(servers).length === 0) return args;
  if (nativeServerNames === null) {
    warnings.push(
      "Couldn't read your Codex config.toml to rule out name clashes; user MCP servers were not added to Codex"
    );
    return args;
  }
  let used = 0;
  for (const [name, server] of Object.entries(servers)) {
    const codexName = `${CODEX_USER_SERVER_PREFIX}${name}`;
    if (nativeServerNames.has(codexName)) {
      warnings.push(
        `mcp.json server "${name}" clashes with "${codexName}" in your Codex config; skipped`
      );
      continue;
    }
    const key = `mcp_servers.${codexName}`;
    const serverArgs: string[] = [];
    if (server.type === "stdio") {
      serverArgs.push(
        "-c",
        `${key}.command=${tomlString(server.command)}`,
        "-c",
        `${key}.args=[${server.args.map(tomlString).join(",")}]`,
        "-c",
        `${key}.env=${tomlInlineTable(server.env)}`
      );
      if (server.cwd) serverArgs.push("-c", `${key}.cwd=${tomlString(server.cwd)}`);
    } else if (server.type === "http") {
      serverArgs.push(
        "-c",
        `${key}.url=${tomlString(server.url)}`,
        "-c",
        `${key}.http_headers=${tomlInlineTable(server.headers)}`
      );
    } else {
      warnings.push(`mcp.json server "${name}" uses SSE, which Codex doesn't support; skipped`);
      continue;
    }
    const size = serverArgs.reduce((total, arg) => total + launchWeight(arg), 0);
    if (used + size > CODEX_USER_ARGS_BUDGET_UNITS) {
      warnings.push(
        `mcp.json server "${name}" would make the Codex launch command too long; skipped`
      );
      continue;
    }
    used += size;
    args.push(...serverArgs);
  }
  return args;
}
