import fs from "node:fs/promises";
import path from "node:path";
import { resolveNextMajorVersion } from "../utils/resolveNextVersion.js";
import { scriptFlagSeparator } from "../../shared/utils/devCommandValidation.js";
export { getInvalidCommandMessage } from "../../shared/utils/devCommandValidation.js";

export const NEXT_DEV_DIRECT_RE = /\bnext\s+dev\b/;
export const TURBOPACK_FLAG_RE = /--turbo(?:pack)?(?![\w-])/;
export const WEBPACK_FLAG_RE = /--webpack(?![\w-])/;
export const PKG_SCRIPT_RE =
  /^(?:npm\s+run|pnpm(?:\s+run)?|yarn(?:\s+run)?|bun(?:\s+run)?)\s+(\S+)$/;
// Compound/piped/commented commands can't be safely rewritten -- appending
// --turbopack to `next dev && echo done` attaches the flag to echo, not next.
export const SHELL_CONTROL_RE = /[;&|#`]|<|>|\$\(/;

export const PORT_FLAG_RE =
  /(?:--port(?:=|\s+)|-p(?:\s+|(?=\d))|\bPORT=)(["']?)(?:\$\{PORT:-)?(\d+)(?![.\w])\}?\1/i;

export const PORT_FLAG_PRESENT_RE = /(?:--port(?:=|\s+)|-p(?:\s+|(?=\d))|\bPORT=)/i;

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
// URL instead of needing UrlDetector to catch a silent reassignment. The
// `(?![\w-])` lookahead keeps `vite-node` and similar hyphenated tools out
// of the match — `\bvite\b` alone would treat `vite-node server.ts` as a
// Vite dev command.
export const VITE_STRICT_PORT_RE = /\bvite(?![\w-])(?:\s+dev)?|\bsvelte-kit\s+dev\b/;

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
  return (
    command
      // `\b` also matched a longer flag that merely starts with the same
      // letters — stripping it turned `--turbopack-root` into `-root`. Not
      // global: a second pass reaches inside quoted argument values.
      .replace(/\s+--turbo(?:pack)?(?![\w-])/, "")
      // Drop npm's forwarding separator only when nothing is left to forward.
      .replace(/\s+--\s*$/, "")
      .trim()
  );
}

async function readPackageScript(cwd: string, scriptName: string): Promise<string | null> {
  try {
    const pkgRaw = await fs.readFile(path.join(cwd, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw);
    const scriptBody = pkg?.scripts?.[scriptName];
    return typeof scriptBody === "string" ? scriptBody : null;
  } catch {
    return null;
  }
}

/** Emitted when the user's command already names a bundler the preference contradicts. */
export interface DevCommandBundlerConflict {
  type: "bundler-conflict";
  message: string;
}

/**
 * Reconcile the project's Turbopack preference with whatever bundler flags the
 * command already carries, across three Next.js eras: pre-15 has no
 * `--turbopack` flag at all, 15 accepts it as an opt-in, and 16 makes Turbopack
 * the default so opting *out* is what needs a flag (`--webpack`). Next 16 also
 * exits 1 on `--webpack --turbopack` ("Pass either `webpack` or `turbopack`,
 * not both"), so an explicit bundler flag always wins over the preference —
 * emitting the fatal pair would be worse than ignoring a toggle.
 */
export async function normalizeNextjsDevCommand(
  command: string,
  cwd: string,
  turbopackEnabled = true,
  onConflict?: (conflict: DevCommandBundlerConflict) => void
): Promise<string> {
  // The renderer pre-injects --turbopack with no version awareness
  // (src/utils/devServerDetection.ts), so a disabled preference has to strip
  // the flag on every exit path, not merely decline to add one.
  const applyPreference = (value: string) => (turbopackEnabled ? value : stripTurbopackFlag(value));

  const nextMajor = await resolveNextMajorVersion(cwd);
  const supportsTurbopackFlag = nextMajor !== null && nextMajor >= 15;
  const turbopackIsDefault = nextMajor !== null && nextMajor >= 16;
  if (!supportsTurbopackFlag) return stripTurbopackFlag(command);
  if (SHELL_CONTROL_RE.test(command)) return applyPreference(command);

  // PKG_SCRIPT_RE is anchored, so `npm run dev -- --turbopack` — what the
  // renderer produces — matches no script. Retry without the turbo flag so the
  // script body can still be inspected for a conflicting `--webpack`. Anything
  // appended goes onto the stripped form, or `npm run dev --` would grow a
  // second forwarding separator.
  const directMatch = PKG_SCRIPT_RE.exec(command);
  const strippedCommand = stripTurbopackFlag(command);
  const scriptMatch = directMatch ?? PKG_SCRIPT_RE.exec(strippedCommand);
  const appendBase = directMatch !== null ? command : strippedCommand;
  let resolved = command;
  if (scriptMatch) {
    const scriptBody = await readPackageScript(cwd, scriptMatch[1]);
    if (scriptBody === null) return applyPreference(command);
    // Mirrors normalizeViteDevCommand: appending to `npm run dev` puts the flag
    // on the last command of a compound body, not on `next dev`.
    if (SHELL_CONTROL_RE.test(scriptBody)) return applyPreference(command);
    resolved = scriptBody;
  }
  if (!NEXT_DEV_DIRECT_RE.test(resolved)) return applyPreference(command);

  const outerHasTurbopack = TURBOPACK_FLAG_RE.test(command);
  const hasTurbopack = outerHasTurbopack || TURBOPACK_FLAG_RE.test(resolved);
  const hasWebpack = WEBPACK_FLAG_RE.test(command) || WEBPACK_FLAG_RE.test(resolved);
  const separator = scriptMatch !== null ? scriptFlagSeparator(command) : " ";

  if (hasWebpack) {
    if (turbopackEnabled) {
      onConflict?.({
        type: "bundler-conflict",
        message: "Command already sets --webpack; the Turbopack preference was not applied.",
      });
    }
    // Only the outer flag is ours to remove — rewriting a package script's own
    // flags would change what every other consumer of that script runs.
    return outerHasTurbopack ? stripTurbopackFlag(command) : command;
  }

  if (!turbopackEnabled) {
    const stripped = strippedCommand;
    // Stripping alone stopped opting out in Next 16: Turbopack runs by default
    // there, so honouring the preference means naming the other bundler.
    if (!turbopackIsDefault) return stripped;
    // ...but only when nothing else still asks for Turbopack. A flag inside the
    // package script survives the strip, and adding --webpack beside it is the
    // fatal pair. Rewriting package.json to resolve it is not ours to do.
    if (
      TURBOPACK_FLAG_RE.test(stripped) ||
      (scriptMatch !== null && TURBOPACK_FLAG_RE.test(resolved))
    ) {
      onConflict?.({
        type: "bundler-conflict",
        message: `The "${scriptMatch?.[1] ?? "dev"}" script sets Turbopack itself; the preference was not applied.`,
      });
      return stripped;
    }
    return `${stripped}${separator}--webpack`;
  }

  if (hasTurbopack || turbopackIsDefault) return command;
  return `${appendBase}${separator}--turbopack`;
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
  // Only npm needs a `--` separator to forward flags through `run <script>`
  // (see scriptFlagSeparator). Direct CLI invocations take flags inline.
  const sep = scriptMatch !== null ? scriptFlagSeparator(command) : " ";
  return `${command}${sep}${flags}`;
}
