import fs from "node:fs/promises";
import path from "node:path";
import type { LaunchMcpInjection } from "../../../shared/config/launchMcp.js";
import type { LaunchMcpBase } from "./renderLaunchMcp.js";

const MAX_BASE_BYTES = 1024 * 1024;

/**
 * Thrown when a format would replace configuration the agent already reads and
 * that configuration cannot be carried forward safely (unreadable, unparseable,
 * too large). The launch then goes ahead without Daintree's servers rather than
 * hiding the user's or an admin's settings.
 */
export class LaunchMcpBaseError extends Error {}

/** Where Gemini CLI reads an admin's system defaults when no variable names a file. */
export function geminiSystemDefaultsPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") {
    return "/Library/Application Support/GeminiCli/system-defaults.json";
  }
  if (platform === "win32") return "C:\\ProgramData\\gemini-cli\\system-defaults.json";
  return "/etc/gemini-cli/system-defaults.json";
}

/** An env lookup with the platform's key semantics: case-insensitive on Windows. */
export function envValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (platform !== "win32") return env[name];
  const wanted = name.toUpperCase();
  let found: string | undefined;
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === wanted) found = value;
  }
  return found;
}

/**
 * JSON with `//` and block comments, as Gemini CLI reads its settings. Strings
 * are skipped verbatim, so a URL's `//` survives.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      // An unclosed comment is a broken file, not a comment to the end.
      if (end === -1) throw new SyntaxError("unterminated block comment");
      i = end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function parseObject(text: string, comments: boolean): Record<string, unknown> | null {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const value: unknown = JSON.parse(comments ? stripJsonComments(body) : body);
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A missing file is no base; a file that exists but cannot be carried forward stops the injection. */
async function readObjectFile(file: string): Promise<LaunchMcpBase> {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new LaunchMcpBaseError(`cannot read ${file}`);
  }
  if (!stat.isFile() || stat.size > MAX_BASE_BYTES) {
    throw new LaunchMcpBaseError(`cannot carry ${file} forward`);
  }
  try {
    const parsed = parseObject(await fs.readFile(file, "utf8"), true);
    if (parsed === null) throw new Error("not an object");
    return parsed;
  } catch {
    throw new LaunchMcpBaseError(`cannot parse ${file}`);
  }
}

function isInside(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export interface ResolveLaunchMcpBaseOptions {
  platform?: NodeJS.Platform;
  /** The agent's working directory, which a relative path in its env is resolved against. */
  cwd?: string;
  /**
   * Daintree's own per-pane config directory. A variable pointing into it was
   * inherited from another pane Daintree launched, not set by the user, and
   * carries that pane's bearers; it is never taken as the user's base.
   */
  managedDir?: string;
}

/**
 * What a format's variable would otherwise have given the agent, so setting it
 * adds to that instead of hiding it: the admin's Gemini system defaults (the
 * file an inherited variable names, else the one beside an inherited system
 * settings file, else the platform's own), an inherited `OPENCODE_CONFIG_CONTENT`
 * or an inherited `VIBE_MCP_SERVERS` list. Null for formats that already merge
 * and whenever there is nothing to carry forward; `LaunchMcpBaseError` when
 * there is something, but it cannot be carried forward safely.
 */
export async function resolveLaunchMcpBase(
  injection: LaunchMcpInjection,
  inheritedEnv: Readonly<Record<string, string | undefined>>,
  options: ResolveLaunchMcpBaseOptions = {}
): Promise<LaunchMcpBase> {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const env = (name: string) => envValue(inheritedEnv, name, platform);
  const resolveFile = (value: string) =>
    pathApi.isAbsolute(value) || !options.cwd ? value : pathApi.resolve(options.cwd, value);
  const managed = (file: string) =>
    options.managedDir !== undefined && isInside(file, options.managedDir);

  switch (injection.format) {
    case "gemini-system-defaults": {
      const named = env(injection.envVar);
      if (named && !managed(resolveFile(named))) return readObjectFile(resolveFile(named));
      const settings = env("GEMINI_CLI_SYSTEM_SETTINGS_PATH");
      if (settings && !managed(resolveFile(settings))) {
        return readObjectFile(
          pathApi.join(pathApi.dirname(resolveFile(settings)), "system-defaults.json")
        );
      }
      return readObjectFile(geminiSystemDefaultsPath(platform));
    }
    case "opencode-config-content": {
      const inherited = env(injection.envVar);
      if (!inherited) return null;
      try {
        const parsed = parseObject(inherited, false);
        if (parsed === null) throw new Error("not an object");
        return parsed;
      } catch {
        throw new LaunchMcpBaseError(`cannot parse the inherited ${injection.envVar}`);
      }
    }
    case "vibe-mcp-servers-env": {
      const inherited = env("VIBE_MCP_SERVERS");
      if (!inherited) return null;
      try {
        const parsed: unknown = JSON.parse(inherited);
        if (!Array.isArray(parsed)) throw new Error("not a list");
        return { servers: parsed };
      } catch {
        throw new LaunchMcpBaseError("cannot parse the inherited VIBE_MCP_SERVERS");
      }
    }
    default:
      return null;
  }
}
