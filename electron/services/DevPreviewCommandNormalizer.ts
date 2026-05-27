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
  [/\bnuxt\s+dev\b/, 3000],
  [/\brails\s+server\b/, 3000],
  [/\bmanage\.py\s+runserver\b/, 8000],
  [/\bmix\s+phx\.server\b/, 4000],
  [/\bphp\s+artisan\s+serve\b/, 8000],
];

// Vite and SvelteKit (SvelteKit v2+ runs on Vite) both expose --strictPort,
// which makes the server exit on EADDRINUSE rather than drifting to the next
// free port. Pinning strictPort lets the readiness poller trust the allocated
// URL instead of needing UrlDetector to catch a silent reassignment.
export const VITE_STRICT_PORT_RE = /\bvite(?:\s+dev)?\b|\bsvelte-kit\s+dev\b/;

// Astro and Nuxt accept --port via their own CLIs but do NOT propagate
// --strictPort to underlying Vite. Injecting it would cause the dev server
// to error on an unknown flag, so we only pin the port here.
export const VITE_SOFT_PORT_RE = /\bastro\s+dev\b|\bnuxt\s+dev\b/;

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

// Vite, SvelteKit, Astro, and Nuxt all ignore process.env.PORT — the only
// boundary-safe way to pin the allocated port is to inject the CLI flag.
// Vite/SvelteKit also accept --strictPort so the server fails fast on
// collision instead of silently drifting; Astro/Nuxt only accept --port.
export async function normalizeViteDevCommand(
  command: string,
  cwd: string,
  port: number
): Promise<string> {
  if (SHELL_CONTROL_RE.test(command)) return command;
  if (PORT_FLAG_PRESENT_RE.test(command)) return command;

  let resolved = command;
  const scriptMatch = PKG_SCRIPT_RE.exec(command);
  if (scriptMatch) {
    const scriptName = scriptMatch[1];
    try {
      const pkgRaw = await fs.readFile(path.join(cwd, "package.json"), "utf-8");
      const pkg = JSON.parse(pkgRaw);
      const scriptBody = pkg?.scripts?.[scriptName];
      if (typeof scriptBody !== "string") return command;
      if (SHELL_CONTROL_RE.test(scriptBody)) return command;
      if (PORT_FLAG_PRESENT_RE.test(scriptBody)) return command;
      resolved = scriptBody;
    } catch {
      return command;
    }
  }

  const isStrict = VITE_STRICT_PORT_RE.test(resolved);
  const isSoft = !isStrict && VITE_SOFT_PORT_RE.test(resolved);
  if (!isStrict && !isSoft) return command;

  const flags = isStrict ? `--port ${port} --strictPort` : `--port ${port}`;
  // npm/pnpm/yarn require `--` to forward flags through `run <script>`; bun
  // forwards extra args directly. Direct CLI invocations (no pkg manager
  // wrapping) take flags inline.
  const isPkgScript = scriptMatch !== null;
  const isBun = command.trimStart().startsWith("bun ");
  const sep = isPkgScript && !isBun ? " -- " : " ";
  return `${command}${sep}${flags}`;
}
