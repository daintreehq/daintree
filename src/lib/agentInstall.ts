import type {
  AgentConfig,
  AgentInstallBlock,
  AgentInstallOS,
} from "../../shared/config/agentRegistry";
import { getHostPlatform, isRemoteWindow } from "@/hooks/useHostPlatform";
import { isMac, isWindows, isLinux } from "./platform";

/**
 * The OS tools and agent CLIs are installed on: the host a remote view's
 * project lives on (a Linux distro under a Windows Shell, say), else this
 * machine. Install guidance for any other OS would be commands for the wrong
 * machine.
 */
export function detectOS(): AgentInstallOS {
  if (isRemoteWindow()) {
    const host = getHostPlatform();
    return host === "darwin" ? "macos" : host === "win32" ? "windows" : "linux";
  }
  if (isMac()) return "macos";
  if (isWindows()) return "windows";
  if (isLinux()) return "linux";
  return "generic";
}

export function getInstallBlocksForCurrentOS(agent: AgentConfig): AgentInstallBlock[] | null {
  if (!agent.install?.byOs) {
    return null;
  }

  const currentOS = detectOS();
  const blocks = agent.install.byOs[currentOS];

  if (blocks && blocks.length > 0) {
    return blocks;
  }

  const genericBlocks = agent.install.byOs.generic;
  if (genericBlocks && genericBlocks.length > 0) {
    return genericBlocks;
  }

  return null;
}

export function getDefaultInstallBlock(agent: AgentConfig): AgentInstallBlock | null {
  const blocks = getInstallBlocksForCurrentOS(agent);
  return blocks && blocks.length > 0 ? (blocks[0] ?? null) : null;
}

export function getInstallCommand(block: AgentInstallBlock): string | null {
  if (!block.commands || block.commands.length === 0) return null;
  return block.commands.join("\n");
}

export function isManualOnlyCommand(command: string): boolean {
  return /\|\s*(bash|sh|zsh)\b/.test(command) || /\|\s*iex\b/.test(command);
}

// For `curl … | bash` / `irm … | iex`-style commands, return the install
// script URL so the UI can offer an inspect-before-running affordance.
// Returns undefined for commands without a pipe-to-shell or without a URL.
export function extractInspectUrl(command: string): string | undefined {
  if (!isManualOnlyCommand(command)) return undefined;
  const match = command.match(/https?:\/\/[^\s|]+/);
  if (!match) return undefined;
  // Trim trailing punctuation that often surrounds inline URLs, e.g. the `)`
  // in `bash <(curl https://x/install.sh)`.
  return match[0].replace(/[)\]'">]+$/, "");
}

/**
 * A leading `sudo` has no pipe for `isManualOnlyCommand` to catch, but running
 * it with piped stdio hangs forever on a password prompt the user can never
 * see. Kept separate from `isManualOnlyCommand` so `extractInspectUrl` keeps
 * meaning "pipes a remote script into a shell". Mirrors the main-side gate in
 * `AgentInstallService`; this copy only decides whether to render a button,
 * main refuses independently.
 */
export function requiresElevation(command: string): boolean {
  return /^\s*sudo\b/i.test(command);
}

/** `npm install -g …` and its spellings: the one install that writes npm's global prefix. */
export function isNpmGlobalInstall(command: string): boolean {
  return (
    /^\s*npm(?:\.cmd)?\s+(?:install|i|add)(?:\s|$)/.test(command) &&
    /\s(?:-g|--global)(?:\s|$)/.test(command)
  );
}

/**
 * Why a global npm install was refused, read from npm's own error report:
 *
 * - `global-folder` — the account can't write where npm installs global
 *   packages (`<prefix>/lib/node_modules`, or the `<prefix>/bin` link), and
 *   that folder is outside any home folder. A system Node (apt, NodeSource,
 *   the nodejs.org macOS installer) puts its prefix there.
 * - `cache` — the account can't write to npm's cache; changing the prefix
 *   doesn't help there. `fixCommand` is the chown npm printed, else one built
 *   for the folder, and null when the folder can't be quoted safely.
 *
 * `folder` is the folder the report names, so the copy can show it rather
 * than guess at who owns it.
 */
export type NpmPermissionFailure =
  | { kind: "global-folder"; folder: string }
  | { kind: "cache"; folder: string; fixCommand: string | null };

/** npm's documented fix for a global folder the account can't write: a prefix in its own home. */
export const NPM_USER_PREFIX_COMMAND = "npm config set prefix ~/.npm-global";

// npm 7+ prefixes report lines "npm error", npm 6 "npm ERR!".
const NPM_REPORT_FIELD = {
  path: /^npm (?:error|ERR!) path (.+?)\s*$/m,
  dest: /^npm (?:error|ERR!) dest (.+?)\s*$/m,
};
// The fix npm prints for a cache it can't write, with this account's ids.
const NPM_CACHE_FIX = /^npm (?:error|ERR!)\s+(sudo chown -R \d+:\d+ "[^"\n]+")\s*$/m;

function npmReportField(output: string, field: "path" | "dest"): string | null {
  return NPM_REPORT_FIELD[field].exec(output)?.[1] ?? null;
}

/** Node's own wording, for a report without npm's `path`/`dest` lines. */
function nodeErrorPaths(output: string): { path: string | null; dest: string | null } {
  const match = /\bE(?:ACCES|PERM): [^,\n]*, \w+ '([^'\n]+)'(?: -> '([^'\n]+)')?/.exec(output);
  return { path: match?.[1] ?? null, dest: match?.[2] ?? null };
}

function globalNodeModulesFolder(filePath: string | null): string | null {
  if (!filePath?.startsWith("/")) return null;
  const match = /^(.*?\/lib\/node_modules)(?:\/|$)/.exec(filePath);
  return match?.[1] ?? null;
}

function parentFolder(filePath: string | null): string | null {
  if (!filePath?.startsWith("/")) return null;
  const index = filePath.lastIndexOf("/");
  return index > 0 ? filePath.slice(0, index) : null;
}

/**
 * The folder as one single-quoted shell word, safe to paste whatever it holds;
 * null for a newline, which would split a pasted command.
 */
function shellQuote(folder: string): string | null {
  if (folder.includes("\n")) return null;
  return `'${folder.replace(/'/g, "'\\''")}'`;
}

const HOME_FOLDER = /^\/(?:home\/[^/]+|Users\/[^/]+|root)(?:\/|$)/;

/**
 * Classifies a failed global npm install on macOS or Linux. Windows reports
 * EPERM for files held open (an editor, antivirus) as readily as for
 * permissions, and keeps global commands in the prefix itself rather than
 * `<prefix>/bin`, so it gets no Unix advice: null there, and for any failure
 * the report doesn't place, leaves the plain error in charge.
 */
export function classifyNpmPermissionFailure(
  command: string,
  output: string,
  os: AgentInstallOS
): NpmPermissionFailure | null {
  if (os !== "linux" && os !== "macos") return null;
  if (!isNpmGlobalInstall(command) || !/\b(?:EACCES|EPERM)\b/.test(output)) return null;

  const fromNode = nodeErrorPaths(output);
  const path = npmReportField(output, "path") ?? fromNode.path;
  const dest = npmReportField(output, "dest") ?? fromNode.dest;

  // npm checks the path against its configured cache itself, and only then
  // prints this, with the chown that fixes it.
  const npmSaysCache = /Your cache folder contains root-owned files/.test(output);
  // The cache folder holds `_cacache`; npm's own chown names that folder.
  const cacheMatch = path ? /^(\/.*?)\/_cacache(?:\/|$)/.exec(path) : null;
  if (npmSaysCache || cacheMatch) {
    const npmFix = NPM_CACHE_FIX.exec(output)?.[1];
    const quoted = npmFix ? /"([^"]+)"/.exec(npmFix)?.[1] : null;
    const folder = quoted ?? cacheMatch?.[1] ?? null;
    if (!folder) return null;
    // Built here rather than copied from npm's text: npm double-quotes the
    // folder, so a `$`, backtick or `$(…)` in it would expand when pasted.
    const quotedFolder = shellQuote(folder);
    const fixCommand = quotedFolder ? `sudo chown -R $(id -u):$(id -g) ${quotedFolder}` : null;
    return { kind: "cache", folder, fixCommand };
  }

  // A command link fails with its relative target into the global packages as
  // `path` and the link in `<prefix>/bin` as `dest`.
  const isBinLink = !!path && !path.startsWith("/") && /(?:^|\/)lib\/node_modules\//.test(path);
  const folder =
    globalNodeModulesFolder(path) ??
    globalNodeModulesFolder(dest) ??
    (isBinLink ? parentFolder(dest) : null);
  // A prefix already inside a home folder is the user's own, so moving it to
  // ~/.npm-global is no fix; that, and anything else, keeps the plain error.
  if (!folder || HOME_FOLDER.test(folder)) return null;
  return { kind: "global-folder", folder };
}

/**
 * The first install method for this OS that doesn't go through npm's global
 * prefix — what to offer when that prefix refuses the install.
 */
export function findNonNpmInstallBlock(
  blocks: readonly AgentInstallBlock[] | null | undefined
): AgentInstallBlock | null {
  return (
    blocks?.find((block) => {
      const commands = block.commands ?? [];
      return commands.length > 0 && !commands.some(isNpmGlobalInstall);
    }) ?? null
  );
}

export function isBlockExecutable(block: AgentInstallBlock): boolean {
  if (!block.commands || block.commands.length === 0) return false;
  return block.commands.every((cmd) => !isManualOnlyCommand(cmd) && !requiresElevation(cmd));
}
