import fs from "node:fs/promises";
import path from "node:path";
import { resolveNextMajorVersion } from "../utils/resolveNextVersion.js";

export function getInvalidCommandMessage(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return "No dev command configured";
  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    return "Multi-line commands are not allowed";
  }
  return null;
}

export const NEXT_DEV_DIRECT_RE = /\bnext\s+dev\b/;
export const TURBOPACK_FLAG_RE = /--turbo(?:pack)?\b/;
export const PKG_SCRIPT_RE =
  /^(?:npm\s+run|pnpm(?:\s+run)?|yarn(?:\s+run)?|bun(?:\s+run)?)\s+(\S+)$/;
// Compound/piped/commented commands can't be safely rewritten -- appending
// --turbopack to `next dev && echo done` attaches the flag to echo, not next.
export const SHELL_CONTROL_RE = /[;&|#]|<|>|\$\(/;

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
