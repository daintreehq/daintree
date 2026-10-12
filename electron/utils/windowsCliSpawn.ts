import path from "node:path";
import { readFileSync } from "node:fs";
import {
  isWindowsLaunchFile as isLaunchFile,
  windowsEnvKey as envKey,
  windowsEnvValue as envValue,
  windowsSystemTool,
} from "./windowsExecutable.js";

const SHELL_INERT_TOKEN = /^[A-Za-z0-9._\-/=:]+$/;
const LAUNCHABLE_EXTENSIONS = new Set([".exe", ".com", ".cmd", ".bat"]);

export function isShellInertInvocation(command: unknown, args: unknown): boolean {
  if (typeof command !== "string" || !Array.isArray(args)) return false;
  return [command, ...args].every(
    (token) => typeof token === "string" && SHELL_INERT_TOKEN.test(token)
  );
}

export function isWindowsShellShim(filePath: string): boolean {
  return /\.(cmd|bat)$/i.test(filePath.trim());
}

export function pickWindowsLaunchable(candidates: readonly string[]): string | undefined {
  const lines = candidates.map((c) => c.trim()).filter(Boolean);
  return (
    lines.find((c) => LAUNCHABLE_EXTENSIONS.has(path.win32.extname(c).toLowerCase())) ?? lines[0]
  );
}

export interface WindowsCliResolveOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  isFile?: (file: string) => boolean;
  readFile?: (file: string) => string;
}

function launchError(command: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Cannot launch CLI: ${command}`), { code, path: command });
}

/** Resolve a real file before spawning; cmd builtins never participate in lookup. */
export function resolveWindowsCli(command: string, options: WindowsCliResolveOptions = {}): string {
  if (!command || /[\0\r\n]/.test(command) || /^[A-Za-z]:(?![\\/])/.test(command)) {
    throw launchError(command, "EINVAL");
  }
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const isFile = options.isFile ?? isLaunchFile;
  const isPath = /[\\/]/.test(command);
  if (!isPath && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(command)) {
    throw launchError(command, "EINVAL");
  }
  const directories = isPath ? [cwd] : (envValue(env, "PATH") ?? "").split(";").filter(Boolean);
  const ext = path.win32.extname(command).toLowerCase();
  const extensions = ext
    ? [""]
    : (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter((suffix) => LAUNCHABLE_EXTENSIONS.has(suffix.toLowerCase()));
  for (const directory of directories) {
    for (const suffix of extensions) {
      // A relative PATH entry (`.\\node_modules\\.bin`) is relative to the
      // launch directory, as it is for the shell that will run the command.
      const candidate = path.win32.resolve(cwd, directory.replace(/^"|"$/g, ""), command + suffix);
      if (
        LAUNCHABLE_EXTENSIONS.has(path.win32.extname(candidate).toLowerCase()) &&
        isFile(candidate)
      ) {
        return candidate;
      }
    }
  }
  throw launchError(command, "ENOENT");
}

export interface CliSpawnTarget {
  command: string;
  args: string[];
  shell: false;
  windowsVerbatimArguments?: boolean;
  /**
   * Variables an unwrapped shim would have set (pnpm's `NODE_PATH`, a `PATH`
   * prepend), already resolved against the caller's env and keyed with its
   * spelling, so `{ ...env, ...target.env }` replaces rather than duplicates.
   */
  env?: Record<string, string>;
}

/** npm shims can target Node scripts or native binaries; bypass the batch boundary. */
function unwrapNpmShim(
  file: string,
  options: WindowsCliResolveOptions
): CliSpawnTarget | undefined {
  const source = (options.readFile ?? ((name) => readFileSync(name, "utf8")))(file);
  if (source.length > 64 * 1024) return undefined;
  const directory = path.win32.dirname(file);
  return (
    unwrapModernNpmShim(source, directory, options) ?? unwrapClassicShim(source, directory, options)
  );
}

// Every line npm's cmd-shim (and its older layouts) writes besides the call
// itself. A shim with any other line, such as one that resets `dp0` or `_prog`
// or changes directory, is not one we can stand in for.
const MODERN_SHIM_LINES = [
  /^@?ECHO\s+off$/i,
  /^GOTO\s+start$/i,
  /^:find_dp0$/i,
  /^SET\s+dp0=%~dp0$/i,
  /^EXIT\s+\/b$/i,
  /^:start$/i,
  /^SETLOCAL$/i,
  /^CALL\s+:find_dp0$/i,
  /^IF\s+EXIST\s+"%dp0%\\node\.exe"\s+\($/i,
  /^SET\s+"_prog=%dp0%\\node\.exe"$/i,
  /^\)\s+ELSE\s+\($/i,
  /^SET\s+"_prog=node"$/i,
  /^SET\s+PATHEXT=%PATHEXT:;\.JS;=;%$/i,
  /^\)$/,
];
const MODERN_SHIM_CALL_PREFIX =
  /^(?:endLocal\s+&\s+goto\s+#_undefined_#\s+2>NUL\s+\|\|\s+title\s+%COMSPEC%\s+&\s+)?(?:set\s+PATHEXT=%PATHEXT:;\.JS;=;%\s+&\s+)?/i;

function isModernNpmShimSource(source: string, callLine: string): boolean {
  let calls = 0;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === callLine) {
      calls++;
      continue;
    }
    if (!MODERN_SHIM_LINES.some((re) => re.test(line))) return false;
  }
  return calls === 1;
}

function unwrapModernNpmShim(
  source: string,
  directory: string,
  options: WindowsCliResolveOptions
): CliSpawnTarget | undefined {
  const isFile = options.isFile ?? isLaunchFile;
  const native = source.match(
    /^"%dp0%[\\/]([^"\r\n]+\.(?:exe|com))"\s*((?:--?[A-Za-z0-9_-]+\s+)*)%\*\s*$/im
  );
  if (native) {
    if (!isModernNpmShimSource(source, native[0].trim())) return undefined;
    const executable = path.win32.resolve(directory, native[1]);
    if (!isFile(executable)) throw launchError(executable, "ENOENT");
    return {
      command: executable,
      args: native[2].trim().split(/\s+/).filter(Boolean),
      shell: false,
    };
  }
  if (!/SET\s+"_prog=node"/i.test(source)) return undefined;
  const call = source.match(
    /"%_prog%"\s*((?:--?[A-Za-z0-9_-]+\s+)*)"%dp0%[\\/]([^"\r\n]+)"\s+%\*\s*$/im
  );
  if (!call) return undefined;
  const callLine = source
    .split(/\r?\n/)
    .find((line) => line.includes(call[0].trim()))
    ?.trim();
  if (!callLine || !MODERN_SHIM_CALL_PREFIX.test(callLine)) return undefined;
  const prefix = MODERN_SHIM_CALL_PREFIX.exec(callLine)?.[0] ?? "";
  if (`${prefix}${call[0].trim()}` !== callLine) return undefined;
  if (!isModernNpmShimSource(source, callLine)) return undefined;
  const script = path.win32.resolve(directory, call[2]);
  if (!isFile(script)) throw launchError(script, "ENOENT");
  const localNode = path.win32.join(directory, "node.exe");
  const node = isFile(localNode) ? localNode : resolveWindowsCli("node.exe", options);
  return {
    command: node,
    args: [...call[1].trim().split(/\s+/).filter(Boolean), script],
    shell: false,
  };
}

const SHIM_FLAG = /^--?[A-Za-z0-9_-]+$/;
// Quoted text with `%%` as cmd's escaped percent (pnpm 11 escapes paths this
// way); any other `%` is an expansion we will not evaluate.
const SHIM_TEXT = String.raw`(?:[^"%\r\n]|%%)+`;
const SHIM_PATH_TEXT = new RegExp(`^${SHIM_TEXT}$`);
// Applied exactly as cmd.exe would, separator included: pnpm can write `:`,
// which Windows reads as part of one (unusable) directory name.
const SHIM_PATH_PREPEND = new RegExp(String.raw`^@SET\s+"PATH=(${SHIM_TEXT})([:;])%PATH%"$`, "i");
const SHIM_NODE_PATH_BLOCK = [
  /^@IF\s+NOT\s+DEFINED\s+NODE_PATH\s+\($/i,
  new RegExp(String.raw`^@SET\s+"NODE_PATH=(${SHIM_TEXT})"$`, "i"),
  /^\)\s+ELSE\s+\($/i,
  new RegExp(String.raw`^@SET\s+"NODE_PATH=(${SHIM_TEXT});%NODE_PATH%"$`, "i"),
  /^\)$/,
];
const SHIM_LOCAL_NODE_IF = /^@IF\s+EXIST\s+"%~dp0\\node\.exe"\s+\($/i;
const SHIM_ELSE = /^\)\s+ELSE\s+\($/i;
const SHIM_PATHEXT = /^@SET\s+PATHEXT=%PATHEXT:;\.JS;=;%$/i;
const SHIM_COMMENT = /^(?:@?REM(?:\s[^&|<>^%]*)?|::.*)$/i;
const SHIM_PREAMBLE = [/^@?ECHO\s+OFF$/i, /^@?SETLOCAL$/i, SHIM_COMMENT];
const SHIM_TRAILER = [/^@?ENDLOCAL$/i, /^@?EXIT\s+\/B(?:\s+%ERRORLEVEL%)?$/i, SHIM_COMMENT];
// pnpm 11 wraps shims with non-ASCII paths in a UTF-8 code page switch.
const PNPM_CODEPAGE_SWITCH = new Set([
  String.raw`@SET "_PNPM_CODEPAGE="`,
  String.raw`@FOR /F "tokens=2 delims=:" %%a IN ('"%SystemRoot%\System32\chcp.com"') DO @SET "_PNPM_CODEPAGE=%%a"`,
  String.raw`@"%SystemRoot%\System32\chcp.com" 65001 >NUL`,
  String.raw`@SET "ERRORLEVEL="`,
]);
const PNPM_CODEPAGE_RESTORE = new Set([
  String.raw`@SET "_PNPM_EXIT_CODE=%ERRORLEVEL%"`,
  String.raw`@IF DEFINED _PNPM_CODEPAGE @"%SystemRoot%\System32\chcp.com" %_PNPM_CODEPAGE% >NUL`,
  String.raw`@EXIT /B %_PNPM_EXIT_CODE%`,
]);

interface ShimToken {
  quoted: boolean;
  value: string;
}

interface ShimCall {
  program: ShimToken;
  args: string[];
  script?: string;
  scriptArgs: string[];
}

/** `<program> <flags> ["<script>" <flags>] %*`, the one call shape the templates write. */
function parseShimCall(line: string): ShimCall | undefined {
  const tokens: ShimToken[] = [];
  const pattern = /\s*(?:"([^"]*)"|([^\s"]+))(?=\s|$)/y;
  while (pattern.lastIndex < line.length) {
    const match = pattern.exec(line);
    if (!match) return undefined;
    tokens.push(
      match[1] === undefined
        ? { quoted: false, value: match[2] ?? "" }
        : { quoted: true, value: match[1] }
    );
  }
  const last = tokens.pop();
  const [program, ...rest] = tokens;
  if (!program || !last || last.quoted || last.value !== "%*") return undefined;
  const scriptIndex = rest.findIndex((token) => token.quoted);
  const flagsOnly = rest.every(
    (token, index) => index === scriptIndex || (!token.quoted && SHIM_FLAG.test(token.value))
  );
  if (!flagsOnly) return undefined;
  const values = rest.map((token) => token.value);
  if (scriptIndex < 0) return { program, args: values, scriptArgs: [] };
  return {
    program,
    args: values.slice(0, scriptIndex),
    script: values[scriptIndex],
    scriptArgs: values.slice(scriptIndex + 1),
  };
}

/** `%~dp0` already ends in a separator; hand-written shims often add another. */
function shimPath(value: string, directory: string): string | undefined {
  const relative = /^%~dp0[\\/]?/i.exec(value);
  const body = relative ? value.slice(relative[0].length) : value;
  if (!SHIM_PATH_TEXT.test(body)) return undefined;
  const decoded = body.replace(/%%/g, "%");
  const valid = relative
    ? !/^[\\/]|:/.test(decoded)
    : /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/.test(decoded);
  return valid ? path.win32.resolve(directory, decoded) : undefined;
}

function sameShimCall(a: ShimCall, b: ShimCall): boolean {
  return (
    JSON.stringify([a.args, a.script, a.scriptArgs]) ===
    JSON.stringify([b.args, b.script, b.scriptArgs])
  );
}

/**
 * The older cmd-shim template (pnpm, Yarn classic, npm <= 6) and minimal
 * hand-written wrappers. Read line by line: anything outside these shapes
 * leaves the shim to the cmd.exe fallback rather than guessing what it runs.
 */
function unwrapClassicShim(
  source: string,
  directory: string,
  options: WindowsCliResolveOptions
): CliSpawnTarget | undefined {
  const callerEnv = options.env ?? process.env;
  const isFile = options.isFile ?? isLaunchFile;
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const env: Record<string, string> = {};
  // Both variables follow the shim's own rule: `<dirs>;<existing>`, else `<dirs>`.
  const prepend = (name: string, dirs: string): void => {
    const key = envKey(callerEnv, name) ?? name;
    const existing = Object.hasOwn(env, key) ? env[key] : callerEnv[key];
    env[key] = existing ? `${dirs};${existing}` : dirs;
  };
  let call: ShimCall | undefined;
  let localNode = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (call) {
      if (PNPM_CODEPAGE_RESTORE.has(line) || SHIM_TRAILER.some((re) => re.test(line))) continue;
      return undefined;
    }
    if (PNPM_CODEPAGE_SWITCH.has(line) || SHIM_PREAMBLE.some((re) => re.test(line))) continue;
    const pathPrepend = SHIM_PATH_PREPEND.exec(line);
    if (pathPrepend) {
      // `%PATH%` expands to nothing in a batch file when PATH is unset.
      const key = envKey(callerEnv, "PATH") ?? "PATH";
      const existing = Object.hasOwn(env, key) ? env[key] : callerEnv[key];
      env[key] = `${(pathPrepend[1] ?? "").replace(/%%/g, "%")}${pathPrepend[2]}${existing ?? ""}`;
      continue;
    }
    if (SHIM_NODE_PATH_BLOCK[0].test(line)) {
      const block = SHIM_NODE_PATH_BLOCK.map((re, offset) => re.exec(lines[index + offset] ?? ""));
      const dirs = block[1]?.[1];
      if (block.some((match) => !match) || !dirs || dirs !== block[3]?.[1]) return undefined;
      prepend("NODE_PATH", dirs.replace(/%%/g, "%"));
      index += SHIM_NODE_PATH_BLOCK.length - 1;
      continue;
    }
    if (SHIM_LOCAL_NODE_IF.test(line)) {
      // npm <= 6 and Yarn open the fallback branch with their SETLOCAL.
      const skip = /^@SETLOCAL$/i.test(lines[index + 3] ?? "") ? 1 : 0;
      const local = parseShimCall(lines[index + 1] ?? "");
      const fallback = parseShimCall(lines[index + 4 + skip] ?? "");
      if (
        !local?.program.quoted ||
        !/^%~dp0\\node\.exe$/i.test(local.program.value) ||
        !fallback ||
        fallback.program.quoted ||
        !/^node$/i.test(fallback.program.value) ||
        !sameShimCall(local, fallback) ||
        !SHIM_ELSE.test(lines[index + 2] ?? "") ||
        !SHIM_PATHEXT.test(lines[index + 3 + skip] ?? "") ||
        lines[index + 5 + skip] !== ")"
      ) {
        return undefined;
      }
      call = fallback;
      localNode = true;
      index += 5 + skip;
      continue;
    }
    call = parseShimCall(line.replace(/^@/, ""));
    if (!call) return undefined;
  }
  if (!call) return undefined;
  const extra = Object.keys(env).length ? { env } : {};

  if (call.script === undefined) {
    if (!call.program.quoted) return undefined;
    const executable = shimPath(call.program.value, directory);
    if (!executable || !/\.(?:exe|com)$/i.test(executable)) return undefined;
    if (!isFile(executable)) throw launchError(executable, "ENOENT");
    return { command: executable, args: call.args, shell: false, ...extra };
  }

  const script = shimPath(call.script, directory);
  if (!script) return undefined;
  let node: string | undefined;
  if (call.program.quoted) {
    node = shimPath(call.program.value, directory);
    if (!node || path.win32.basename(node).toLowerCase() !== "node.exe") return undefined;
  } else if (!/^node(?:\.exe)?$/i.test(call.program.value)) {
    return undefined;
  }
  if (!isFile(script)) throw launchError(script, "ENOENT");
  if (node) {
    if (!isFile(node)) throw launchError(node, "ENOENT");
  } else {
    const local = path.win32.join(directory, "node.exe");
    // A bare `node` runs after the shim's own PATH change, so look it up there.
    node =
      localNode && isFile(local)
        ? local
        : resolveWindowsCli("node.exe", { ...options, env: { ...callerEnv, ...env } });
  }
  return {
    command: node,
    args: [...call.args, script, ...call.scriptArgs],
    shell: false,
    ...extra,
  };
}

export function cliSpawnTarget(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  options: WindowsCliResolveOptions = {}
): CliSpawnTarget {
  if (platform !== "win32") return { command, args: [...args], shell: false };
  const file = resolveWindowsCli(command, options);
  if (!isWindowsShellShim(file)) return { command: file, args: [...args], shell: false };
  const nodeTarget = unwrapNpmShim(file, options);
  if (nodeTarget) return { ...nodeTarget, args: [...nodeTarget.args, ...args] };
  // Only confirmed non-Node shims with inert probe arguments reach cmd.exe.
  // Quotes protect spaces in the resolved path; expansion characters are refused.
  if (/["%^!&|<>\r\n]/.test(file) || !args.every((arg) => SHELL_INERT_TOKEN.test(arg))) {
    throw launchError(file, "EINVAL");
  }
  return {
    command: windowsSystemTool("cmd.exe", options.env ?? process.env),
    args: ["/d", "/s", "/v:off", "/c", `""${file}" ${args.join(" ")}"`],
    shell: false,
    windowsVerbatimArguments: true,
  };
}
