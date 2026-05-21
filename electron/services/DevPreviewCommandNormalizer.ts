import fs from "node:fs/promises";
import path from "node:path";
import { resolveNextMajorVersion } from "../utils/resolveNextVersion.js";
export { getInvalidCommandMessage } from "../../shared/utils/devCommandValidation.js";

export const NEXT_DEV_DIRECT_RE = /\bnext\s+dev\b/;
export const TURBOPACK_FLAG_RE = /--turbo(?:pack)?\b/;
export const PKG_SCRIPT_RE =
  /^(?:npm\s+run|pnpm(?:\s+run)?|yarn(?:\s+run)?|bun(?:\s+run)?)\s+(\S+)$/;
// Compound/piped/commented commands can't be safely rewritten -- appending
// --turbopack to `next dev && echo done` attaches the flag to echo, not next.
export const SHELL_CONTROL_RE = /[;&|#`]|<|>|\$\(/;

export const PORT_FLAG_RE =
  /(?:--port(?:=|\s+)|-p\s+|\bPORT=)(["']?)(?:\$\{PORT:-)?(\d+)(?![.\w])\}?\1/i;

export const PORT_FLAG_PRESENT_RE = /(?:--port(?:=|\s+)|-p\s+|\bPORT=)/i;

export const FRAMEWORK_DEFAULT_PORTS: Array<[RegExp, number]> = [
  [/\bnext\s+dev\b/, 3000],
  [/\bremix\s+(?:dev|run|start|watch)\b/, 3000],
  [/\bvite\b/, 5173],
  [/\bsvelte-kit\s+dev\b/, 5173],
  [/\bastro\s+dev\b/, 4321],
  [/\brails\s+server\b/, 3000],
  [/\bmanage\.py\s+runserver\b/, 8000],
  [/\bmix\s+phx\.server\b/, 4000],
  [/\bphp\s+artisan\s+serve\b/, 8000],
];

export async function extractPort(command: string, cwd: string): Promise<number | null> {
  if (SHELL_CONTROL_RE.test(command)) return null;

  let resolved = command;

  const scriptMatch = PKG_SCRIPT_RE.exec(command);
  if (scriptMatch) {
    const scriptName = scriptMatch[1];
    try {
      const pkgRaw = await fs.readFile(path.join(cwd, "package.json"), "utf-8");
      const pkg = JSON.parse(pkgRaw);
      const scriptBody = pkg?.scripts?.[scriptName];
      if (typeof scriptBody === "string") {
        if (SHELL_CONTROL_RE.test(scriptBody)) return null;
        resolved = scriptBody;
      }
    } catch {
      // package.json missing or invalid — continue with original command
    }
  }

  const flagMatch = PORT_FLAG_RE.exec(resolved);
  if (flagMatch) {
    const port = parseInt(flagMatch[2], 10);
    if (port >= 1 && port <= 65535) return port;
    return null;
  }

  if (PORT_FLAG_PRESENT_RE.test(resolved)) return null;

  for (const [re, defaultPort] of FRAMEWORK_DEFAULT_PORTS) {
    if (re.test(resolved)) return defaultPort;
  }

  return null;
}

export function stripTurbopackFlag(command: string): string {
  return command
    .replace(/\s+--\s+--turbo(?:pack)?\b/, "") // " -- --turbopack" (pkg manager form)
    .replace(/\s+--turbo(?:pack)?\b/, "") // " --turbopack" (direct form)
    .trim();
}

export async function normalizeNextjsDevCommand(
  command: string,
  cwd: string,
  turbopackEnabled = true
): Promise<string> {
  if (!turbopackEnabled) return stripTurbopackFlag(command);
  const nextMajor = await resolveNextMajorVersion(cwd);
  if (nextMajor === null || nextMajor < 15) return stripTurbopackFlag(command);

  if (TURBOPACK_FLAG_RE.test(command)) return command;
  if (SHELL_CONTROL_RE.test(command)) return command;

  if (NEXT_DEV_DIRECT_RE.test(command)) {
    return `${command} --turbopack`;
  }

  const scriptMatch = PKG_SCRIPT_RE.exec(command);
  if (!scriptMatch) return command;

  const scriptName = scriptMatch[1];
  try {
    const pkgRaw = await fs.readFile(path.join(cwd, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw);
    const scriptBody = pkg?.scripts?.[scriptName];
    if (typeof scriptBody === "string" && NEXT_DEV_DIRECT_RE.test(scriptBody)) {
      if (TURBOPACK_FLAG_RE.test(scriptBody)) return command;
      const sep = command.trimStart().startsWith("bun ") ? " " : " -- ";
      return `${command}${sep}--turbopack`;
    }
  } catch {
    // No package.json or invalid — leave command unchanged
  }

  return command;
}
