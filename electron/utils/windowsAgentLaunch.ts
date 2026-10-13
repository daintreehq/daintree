import { WINDOWS_PS_UTF8_BOOTSTRAP } from "../services/pty/terminalShell.js";
import { quotePowerShellArg } from "../../shared/utils/shellEscape.js";
import {
  resolveWindowsCliTarget,
  windowsCliSpawnTarget,
  type CliSpawnTarget,
  type WindowsCliResolution,
  type WindowsCliResolveOptions,
} from "./windowsCliSpawn.js";
import { windowsEnvValue } from "./windowsExecutable.js";

/** Decode generated argv literals without evaluating any PowerShell source. */
export function parseWindowsAgentCommand(command: string): string[] {
  return parseWords(command, Infinity);
}

function parseWords(command: string, limit: number): string[] {
  let source = command.trim();
  if (source.startsWith("& ")) source = source.slice(2).trimStart();
  const words: string[] = [];
  let offset = 0;
  while (offset < source.length && words.length < limit) {
    while (/\s/.test(source[offset] ?? "") && offset < source.length) offset++;
    if (offset === source.length) break;
    let word = "";
    const quote = source[offset];
    if (quote === "'" || quote === '"') {
      offset++;
      let closed = false;
      while (offset < source.length) {
        const char = source[offset++];
        const delimiter = char === quote || (quote === "'" && /[\u2018-\u201b]/.test(char));
        if (delimiter) {
          if (source[offset] === char) {
            word += char;
            offset++;
          } else {
            closed = true;
            break;
          }
        } else word += char;
      }
      if (!closed || (offset < source.length && !/\s/.test(source[offset]))) {
        throw new Error("Invalid quoted Windows agent argument");
      }
    } else {
      const start = offset;
      while (offset < source.length && !/\s/.test(source[offset])) offset++;
      word = source.slice(start, offset);
      if (!/^[A-Za-z0-9_./:\\=+-]+$/.test(word)) {
        throw new Error("Windows agent arguments must be literal values");
      }
    }
    if (word.includes("\0")) throw new Error("Invalid Windows agent argument");
    words.push(word);
  }
  if (!words.length) throw new Error("Missing Windows agent command");
  return words;
}

/** Windows CRT argv serialization, used directly by ProcessStartInfo.Arguments. */
export function serializeWindowsArgv(args: readonly string[]): string {
  return args
    .map((arg) => `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`)
    .join(" ");
}

/**
 * A batch file we cannot unwrap may only reach cmd.exe with inert arguments,
 * because cmd.exe re-parses the line; anything else is refused with a way out.
 */
function agentLaunchTarget(
  resolution: WindowsCliResolution,
  args: readonly string[],
  env: NodeJS.ProcessEnv
): CliSpawnTarget {
  try {
    return windowsCliSpawnTarget(resolution, args, env);
  } catch (error) {
    // Only the arguments differ between the calls, so a bare cmd.exe target
    // means they were the reason.
    let bare: CliSpawnTarget | undefined;
    try {
      bare = windowsCliSpawnTarget(resolution, [], env);
    } catch {
      // The original failure stands.
    }
    if (!bare?.windowsVerbatimArguments || resolution.kind !== "batch") throw error;
    const shim = (error as NodeJS.ErrnoException).path ?? resolution.file;
    throw new Error(
      `Cannot pass these launch arguments through ${shim}: Daintree cannot unwrap this batch file, and cmd.exe would rewrite them. Install the CLI with npm or as a native executable, or launch it without a prompt.`,
      { cause: error }
    );
  }
}

/** What a resolution depends on besides the executable word itself. */
function resolutionEnvKey(env: NodeJS.ProcessEnv): string {
  return JSON.stringify(
    ["PATH", "PATHEXT", "NODE_PATH", "SYSTEMROOT", "WINDIR"].map(
      (name) => windowsEnvValue(env, name) ?? null
    )
  );
}

/**
 * The executable of a Windows agent command, resolved ahead of the launch: the
 * PATH search, the shim read and the Node lookup are asynchronous, so a PATH
 * entry on a dead share never blocks Main, and the launch script is then built
 * synchronously. Never rejects: a failure is kept and thrown by
 * `buildWindowsAgentLaunchScript`, where the launch would have failed anyway.
 */
export interface WindowsAgentExecutable {
  /** The command's first word, as it was resolved; undefined when it did not parse. */
  readonly file: string | undefined;
  readonly envKey: string;
  readonly resolution?: WindowsCliResolution;
  readonly error?: unknown;
}

export async function resolveWindowsAgentExecutable(
  command: string,
  options: WindowsCliResolveOptions = {}
): Promise<WindowsAgentExecutable> {
  const envKey = resolutionEnvKey(options.env ?? process.env);
  let file: string | undefined;
  try {
    // Only the first word: the arguments can still change before the launch.
    [file] = parseWords(command, 1);
    if (file === undefined) throw new Error("Missing Windows agent command");
    return { file, envKey, resolution: await resolveWindowsCliTarget(file, options) };
  } catch (error) {
    return { file, envKey, error };
  }
}

/**
 * Whether `executable` still answers for `command` under `env`: the same first
 * word and the same PATH, PATHEXT, NODE_PATH and SystemRoot. A command whose
 * first word does not parse counts as matching, so the build reports it.
 */
export function isWindowsAgentExecutableFor(
  executable: WindowsAgentExecutable,
  command: string,
  env: NodeJS.ProcessEnv
): boolean {
  let file: string | undefined;
  try {
    [file] = parseWords(command, 1);
  } catch {
    return true;
  }
  return file === executable.file && resolutionEnvKey(env) === executable.envKey;
}

/** Inherit the PTY handles while avoiding both cmd.exe and PowerShell's native binder. */
export function buildWindowsAgentLaunchScript(
  command: string,
  executable: WindowsAgentExecutable,
  env: NodeJS.ProcessEnv = process.env
): string {
  const [file, ...args] = parseWindowsAgentCommand(command);
  if (file !== executable.file) {
    throw new Error(`The Windows agent executable ${file} was not resolved for this launch`);
  }
  if (!executable.resolution) throw executable.error;
  const target = agentLaunchTarget(executable.resolution, args, env);
  // A cmd.exe target already holds its exact command line (`/d /s /v:off /c ""shim" args"`).
  const commandLine = target.windowsVerbatimArguments
    ? target.args.join(" ")
    : serializeWindowsArgv(target.args);
  return [
    WINDOWS_PS_UTF8_BOOTSTRAP,
    "& {",
    "  $start = [System.Diagnostics.ProcessStartInfo]::new()",
    `  $start.FileName = ${quotePowerShellArg(target.command)}`,
    `  $start.Arguments = ${quotePowerShellArg(commandLine)}`,
    "  $start.UseShellExecute = $false",
    "  $start.WorkingDirectory = (Get-Location).ProviderPath",
    // What an unwrapped shim would have set (NODE_PATH, a PATH prepend).
    ...Object.entries(target.env ?? {}).map(
      ([name, value]) =>
        `  $start.Environment[${quotePowerShellArg(name)}] = ${quotePowerShellArg(value)}`
    ),
    "  $child = [System.Diagnostics.Process]::Start($start)",
    "  try { $child.WaitForExit(); $global:LASTEXITCODE = $child.ExitCode } finally { $child.Dispose() }",
    "}",
  ].join("\n");
}
