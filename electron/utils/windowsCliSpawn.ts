import path from "node:path";
import { readFileSync, statSync, lstatSync } from "node:fs";

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

function isLaunchFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    // Windows Store execution aliases are reparse points: stat reports EACCES,
    // while CreateProcess can still launch the alias by its resolved file name.
    try {
      return lstatSync(file).isSymbolicLink();
    } catch {
      return false;
    }
  }
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  // Node sorts duplicate Windows env keys and forwards the first case variant.
  const key = Object.keys(env)
    .sort()
    .find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
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
}

/** npm shims can target Node scripts or native binaries; bypass the batch boundary. */
function unwrapNpmShim(
  file: string,
  options: WindowsCliResolveOptions
): CliSpawnTarget | undefined {
  const source = (options.readFile ?? ((name) => readFileSync(name, "utf8")))(file);
  if (source.length > 64 * 1024) return undefined;
  const directory = path.win32.dirname(file);
  const isFile = options.isFile ?? isLaunchFile;
  const native = source.match(
    /^"%dp0%[\\/]([^"\r\n]+\.(?:exe|com))"\s*((?:--?[A-Za-z0-9_-]+\s+)*)%\*\s*$/im
  );
  if (native) {
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
  const env = options.env ?? process.env;
  const systemRoot = envValue(env, "SYSTEMROOT") ?? "C:\\Windows";
  return {
    command: path.win32.join(systemRoot, "System32", "cmd.exe"),
    args: ["/d", "/s", "/v:off", "/c", `""${file}" ${args.join(" ")}"`],
    shell: false,
    windowsVerbatimArguments: true,
  };
}
