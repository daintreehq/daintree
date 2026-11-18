import fs from "fs";
import path from "path";
import os from "os";
import { openWithDefaultApp } from "../utils/openPath.js";
import { linuxDesktopAppEnv } from "./pty/EnvironmentFilter.js";
import {
  JETBRAINS_EDITOR_IDS,
  LEGACY_JETBRAINS_EDITOR_ID,
  terminalOnlyEditorCommand,
  type DiscoveredEditor,
  type EditorConfig,
  type JetBrainsEditorId,
  type KnownEditorId,
} from "../../shared/types/editor.js";
import type { SystemOpenInEditorNeedsTerminal } from "../../shared/types/ipc/system.js";
import { withPathProbeSlot } from "../utils/findOnPath.js";
import { findWindowsPathFile, windowsEnvValue } from "../utils/windowsExecutable.js";

interface EditorDefinition {
  id: KnownEditorId;
  name: string;
  /** Primary binary name (or full path) to search in PATH */
  binaries: string[];
  /** Additional directories to search beyond PATH (e.g. JetBrains Toolbox) */
  extraDirs?: () => string[];
  /**
   * Build the argv for opening a target at line/col. `isDirectory` is true when
   * the target is a folder, in which case `line`/`col` are always undefined —
   * `openFile` drops them before it gets here, since no editor CLI can navigate
   * to a coordinate inside a directory. Most builders therefore need no branch:
   * their no-coordinate form (a bare path) is already the folder-open syntax.
   */
  buildArgs(filePath: string, line?: number, col?: number, isDirectory?: boolean): string[];
}

interface JetBrainsProduct {
  name: string;
  /** The launcher name, both for a Toolbox script and inside the app bundle */
  binary: string;
  /** macOS app bundle names, the community edition after the paid one */
  bundles: string[];
}

const JETBRAINS_PRODUCTS: Record<JetBrainsEditorId, JetBrainsProduct> = {
  "jetbrains-webstorm": { name: "WebStorm", binary: "webstorm", bundles: ["WebStorm"] },
  "jetbrains-idea": {
    name: "IntelliJ IDEA",
    binary: "idea",
    bundles: ["IntelliJ IDEA", "IntelliJ IDEA CE"],
  },
  "jetbrains-phpstorm": { name: "PhpStorm", binary: "phpstorm", bundles: ["PhpStorm"] },
  "jetbrains-pycharm": { name: "PyCharm", binary: "pycharm", bundles: ["PyCharm", "PyCharm CE"] },
  "jetbrains-goland": { name: "GoLand", binary: "goland", bundles: ["GoLand"] },
  "jetbrains-rider": { name: "Rider", binary: "rider", bundles: ["Rider"] },
  "jetbrains-clion": { name: "CLion", binary: "clion", bundles: ["CLion"] },
  "jetbrains-datagrip": { name: "DataGrip", binary: "datagrip", bundles: ["DataGrip"] },
  "jetbrains-rubymine": { name: "RubyMine", binary: "rubymine", bundles: ["RubyMine"] },
};

function jetbrainsBuildArgs(filePath: string, line?: number): string[] {
  if (line !== undefined) {
    return ["--line", String(line), filePath];
  }
  return [filePath];
}

function jetbrainsDirs(products: JetBrainsProduct[]): () => string[] {
  return () => [
    ...jetbrainsToolboxScriptDirs(),
    ...macAppBundleDirs(products.flatMap((product) => product.bundles).map((name) => ({ name }))),
  ];
}

/**
 * One entry per IDE, in the order their launchers were searched when they shared
 * a single entry, so the automatic pick in `openFile` lands on the IDE it always did.
 */
const JETBRAINS_EDITORS: EditorDefinition[] = JETBRAINS_EDITOR_IDS.map((id) => {
  const product = JETBRAINS_PRODUCTS[id];
  return {
    id,
    name: product.name,
    binaries: [product.binary],
    extraDirs: jetbrainsDirs([product]),
    buildArgs: jetbrainsBuildArgs,
  };
});

/**
 * The single entry a saved `webstorm` names: every JetBrains launcher, searched
 * launcher first and directory second, exactly as before the split. Not
 * discovered on its own, since each IDE it can find already is.
 */
const LEGACY_JETBRAINS: EditorDefinition = {
  id: LEGACY_JETBRAINS_EDITOR_ID,
  name: "JetBrains IDE",
  binaries: JETBRAINS_EDITOR_IDS.map((id) => JETBRAINS_PRODUCTS[id].binary),
  extraDirs: jetbrainsDirs(JETBRAINS_EDITOR_IDS.map((id) => JETBRAINS_PRODUCTS[id])),
  buildArgs: jetbrainsBuildArgs,
};

const KNOWN_EDITORS: EditorDefinition[] = [
  {
    id: "vscode",
    name: "VS Code",
    binaries: ["code"],
    extraDirs: () =>
      macAppBundleDirs([{ name: "Visual Studio Code", subPath: "Contents/Resources/app/bin" }]),
    // `--goto` names a file to navigate into; handed a folder the whole VS Code
    // family opens the path as a text buffer instead of the workspace (#12329).
    buildArgs(filePath, line, col, isDirectory) {
      if (isDirectory) return [filePath];
      const target =
        line !== undefined ? `${filePath}:${line}${col !== undefined ? `:${col}` : ""}` : filePath;
      return ["--goto", target];
    },
  },
  {
    id: "vscode-insiders",
    name: "VS Code Insiders",
    binaries: ["code-insiders"],
    extraDirs: () =>
      macAppBundleDirs([
        { name: "Visual Studio Code - Insiders", subPath: "Contents/Resources/app/bin" },
      ]),
    buildArgs(filePath, line, col, isDirectory) {
      if (isDirectory) return [filePath];
      const target =
        line !== undefined ? `${filePath}:${line}${col !== undefined ? `:${col}` : ""}` : filePath;
      return ["--goto", target];
    },
  },
  {
    id: "cursor",
    name: "Cursor",
    binaries: ["cursor"],
    extraDirs: () => macAppBundleDirs([{ name: "Cursor", subPath: "Contents/Resources/app/bin" }]),
    buildArgs(filePath, line, col, isDirectory) {
      if (isDirectory) return [filePath];
      const target =
        line !== undefined ? `${filePath}:${line}${col !== undefined ? `:${col}` : ""}` : filePath;
      return ["--goto", target];
    },
  },
  {
    id: "windsurf",
    name: "Windsurf",
    binaries: ["windsurf"],
    extraDirs: () =>
      macAppBundleDirs([{ name: "Windsurf", subPath: "Contents/Resources/app/bin" }]),
    buildArgs(filePath, line, col, isDirectory) {
      if (isDirectory) return [filePath];
      const target =
        line !== undefined ? `${filePath}:${line}${col !== undefined ? `:${col}` : ""}` : filePath;
      return ["--goto", target];
    },
  },
  {
    id: "zed",
    name: "Zed",
    binaries: ["zed"],
    buildArgs(filePath, line, col) {
      const target =
        line !== undefined ? `${filePath}:${line}${col !== undefined ? `:${col}` : ""}` : filePath;
      return [target];
    },
  },
  {
    id: "neovim",
    name: "Neovim",
    binaries: ["nvim"],
    buildArgs(filePath, line) {
      if (line !== undefined) {
        return [`+${line}`, filePath];
      }
      return [filePath];
    },
  },
  ...JETBRAINS_EDITORS,
  {
    id: "sublime",
    name: "Sublime Text",
    binaries: ["subl"],
    extraDirs: () =>
      macAppBundleDirs([{ name: "Sublime Text", subPath: "Contents/SharedSupport/bin" }]),
    buildArgs(filePath, line, col) {
      const target =
        line !== undefined ? `${filePath}:${line}${col !== undefined ? `:${col}` : ""}` : filePath;
      return [target];
    },
  },
  // Appended last on purpose: KNOWN_EDITORS order is also the auto-pick priority in
  // openFile's fallback, so a new editor must not demote one users already have.
  {
    id: "antigravity-ide",
    name: "Antigravity IDE",
    binaries: ["antigravity-ide"],
    extraDirs: () =>
      macAppBundleDirs([{ name: "Antigravity IDE", subPath: "Contents/Resources/app/bin" }]),
    buildArgs(filePath, line, col, isDirectory) {
      if (isDirectory) return [filePath];
      const target =
        line !== undefined ? `${filePath}:${line}${col !== undefined ? `:${col}` : ""}` : filePath;
      return ["--goto", target];
    },
  },
];

const TERMINAL_EDITORS = new Set<string>([
  "vim",
  "vi",
  "nvim",
  "nano",
  "emacs",
  "emacs-nox",
  "pico",
  "helix",
  "hx",
  "kak",
  "micro",
  "ed",
  "joe",
  "jed",
  "mg",
  "mcedit",
  "ne",
  "tilde",
]);

function tokenizeArgString(input: string): string[] {
  const expanded = input.replace(/^~(?=\/|$)/, os.homedir());
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let hasContent = false;

  for (let i = 0; i < expanded.length; i++) {
    const ch = expanded[i];
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      hasContent = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasContent = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasContent) {
        tokens.push(current);
        current = "";
        hasContent = false;
      }
      continue;
    }
    current += ch;
    hasContent = true;
  }
  if (hasContent) tokens.push(current);
  return tokens;
}

function macAppBundleDirs(apps: Array<{ name: string; subPath?: string }>): string[] {
  if (process.platform !== "darwin") return [];
  const dirs: string[] = [];
  for (const { name, subPath = "Contents/MacOS" } of apps) {
    dirs.push(path.posix.join("/Applications", `${name}.app`, subPath));
    dirs.push(path.posix.join(os.homedir(), "Applications", `${name}.app`, subPath));
  }
  return dirs;
}

function jetbrainsToolboxScriptDirs(): string[] {
  const dirs: string[] = [];
  if (process.platform === "darwin") {
    dirs.push(
      path.posix.join(
        os.homedir(),
        "Library",
        "Application Support",
        "JetBrains",
        "Toolbox",
        "scripts"
      )
    );
  } else if (process.platform === "linux") {
    dirs.push(path.posix.join(os.homedir(), ".local", "share", "JetBrains", "Toolbox", "scripts"));
  } else if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA || path.win32.join(os.homedir(), "AppData", "Local");
    dirs.push(path.win32.join(localAppData, "JetBrains", "Toolbox", "scripts"));
  }
  return dirs;
}

function binaryCandidates(binary: string, extraDirs: string[]): string[] {
  const pathDirs = (process.env.PATH ?? "").split(path.posix.delimiter).filter(Boolean);
  return [...extraDirs, ...pathDirs].map((dir) => path.posix.join(dir, binary));
}

async function isExecutableFile(fullPath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(fullPath);
    if (!stat.isFile()) return false;
    await fs.promises.access(fullPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The Windows PATH search, with `extraDirs` ahead of PATH. It shares its slots
 * and per-directory deadline with every other Windows lookup, so a PATH entry
 * on a dropped network share is searched past rather than waited on. Only
 * absolute directories count, so the working directory is never searched.
 */
function findWindowsEditor(binary: string, extraDirs: string[] = []): Promise<string | null> {
  const searchPath = [
    ...extraDirs.map((dir) => (dir.includes(";") ? `"${dir}"` : dir)),
    windowsEnvValue(process.env, "PATH") ?? "",
  ]
    .filter(Boolean)
    .join(";");
  // A name that already has an extension (`notepad++.exe`) is tried as given
  // first, then each PATHEXT extension: execa starts what cmd.exe can, which
  // includes a `.vbs` wrapper run by its file association.
  const extensions = (windowsEnvValue(process.env, "PATHEXT") ?? ".EXE;.CMD;.BAT")
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
  const candidates = [
    ...(path.win32.extname(binary) ? [binary] : []),
    ...extensions.map((extension) => binary + extension),
  ];
  return findWindowsPathFile(candidates, { PATH: searchPath });
}

function resolveEditorDef(id: KnownEditorId): EditorDefinition | undefined {
  if (id === LEGACY_JETBRAINS_EDITOR_ID) return LEGACY_JETBRAINS;
  return KNOWN_EDITORS.find((e) => e.id === id);
}

/**
 * The same walk as a synchronous PATH lookup — binaries first, then extra
 * dirs, then PATH, one candidate at a time — so it touches exactly the paths
 * and picks exactly the file a sequential search would. Only the waiting moves
 * off the main thread; separate editors walk concurrently under the slot cap,
 * which is shared with every POSIX PATH lookup (`findOnPath`) so that together
 * they can never hold more of libuv's fs pool than the cap allows. Windows
 * goes through its own PATH search, in PATHEXT order within each directory.
 */
async function findExecutable(def: EditorDefinition): Promise<string | null> {
  const extraDirs = def.extraDirs ? def.extraDirs() : [];
  if (process.platform === "win32") {
    for (const binary of def.binaries) {
      const found = await findWindowsEditor(binary, extraDirs);
      if (found) return found;
    }
    return null;
  }
  for (const binary of def.binaries) {
    for (const candidate of binaryCandidates(binary, extraDirs)) {
      if (await withPathProbeSlot(() => isExecutableFile(candidate))) return candidate;
    }
  }
  return null;
}

/**
 * The program to launch for an editor command the user configured (a custom
 * command, `$VISUAL`, `$EDITOR`). On Windows a bare name is looked up in PATH
 * first, because execa, like process creation, would otherwise look in the
 * working directory before PATH; null when PATH has none, which the caller
 * treats as a failed launch. A path, and every name off Windows, passes through.
 */
async function launchProgram(binary: string): Promise<string | null> {
  if (process.platform !== "win32" || /[\\/:]/.test(binary)) return binary;
  return findWindowsEditor(binary);
}

export async function discover(): Promise<DiscoveredEditor[]> {
  return Promise.all(
    KNOWN_EDITORS.map(async (def) => {
      const executablePath = (await findExecutable(def)) ?? undefined;
      return {
        id: def.id,
        name: def.name,
        available: executablePath !== undefined,
        executablePath,
      };
    })
  );
}

/**
 * A placeholder together with the `:` that introduces it, so an absent
 * coordinate takes its own punctuation with it. Deliberately only `:` — the
 * form this app's settings UI documents and defaults to. Punctuation in a
 * hand-written template can carry meaning we have no basis to reinterpret: a
 * bare `+` is vim's "start at the last line", and a `,` may be a field
 * delimiter whose empty slot the wrapper still counts.
 */
const CUSTOM_PLACEHOLDER = /(:)?\{(file|line|col)\}/g;

type CustomPlaceholder = "file" | "line" | "col";

/**
 * Interpolate a custom-editor template, dropping the punctuation an absent
 * coordinate would otherwise strand. The settings UI defaults the template to
 * `{file}:{line}:{col}`, so without this a target with no line renders
 * `/path/to/thing::` — which every editor treats as a different, missing file.
 * That is unconditional for a directory (folders have no coordinates) and was
 * already reachable for any file opened without one.
 *
 * Nothing else about the template is second-guessed. The token itself always
 * survives, because a template can be positional (`"{line}" "{col}" "{file}"`)
 * and removing an empty argument would slide the path into the column's slot;
 * and a flag token that names a coordinate (`--line {line}`) is left standing,
 * since working out which of a user's own arguments existed only to carry a
 * line means guessing at a command grammar we don't know.
 */
function buildCustomArgs(
  template: string,
  command: string,
  filePath: string,
  line?: number,
  col?: number
): { binary: string; args: string[] } {
  const values: Record<CustomPlaceholder, string> = {
    file: filePath,
    line: line !== undefined ? String(line) : "",
    col: col !== undefined ? String(col) : "",
  };

  const args = tokenizeArgString(template).map((token) =>
    token.replace(CUSTOM_PLACEHOLDER, (_match, separator: string | undefined, name) => {
      const value = values[name as CustomPlaceholder];
      return value === "" ? "" : `${separator ?? ""}${value}`;
    })
  );
  return { binary: command, args };
}

function envEditorBinaryName(binary: string): string {
  let name = path.basename(binary).toLowerCase();
  if (process.platform === "win32") {
    name = name.replace(/\.(exe|cmd|bat)$/, "");
  }
  return name;
}

// A user who already wrote their own navigation flag (or an end-of-options
// marker) has chosen the syntax, and appending ours could change its meaning.
const USER_NAVIGATION_ARG = /^(--|-g|--goto(=.*)?|--line(=.*)?|--column(=.*)?)$/;

async function tryEnvEditor(
  envEditor: string,
  filePath: string,
  line: number | undefined,
  col: number | undefined,
  isDirectory: boolean,
  launchEditor: (binary: string, args: string[]) => Promise<boolean>
): Promise<boolean> {
  const tokens = tokenizeArgString(envEditor);
  if (tokens.length === 0) return false;
  const [binary, ...extraArgs] = tokens;
  // Skip terminal editors — spawning them detached + stdio:"ignore" produces an
  // invisible hung process. Fall through to GUI-capable fallbacks instead.
  if (TERMINAL_EDITORS.has(envEditorBinaryName(binary))) return false;
  // A known GUI named by $VISUAL/$EDITOR gets the same location syntax as when
  // it is picked from the list; the user's own flags stay ahead of it.
  const binaryName = envEditorBinaryName(binary);
  const def = KNOWN_EDITORS.find((e) => e.binaries.includes(binaryName));
  if (def && line !== undefined && !extraArgs.some((arg) => USER_NAVIGATION_ARG.test(arg))) {
    return launchEditor(binary, [...extraArgs, ...def.buildArgs(filePath, line, col, isDirectory)]);
  }
  return launchEditor(binary, [...extraArgs, filePath]);
}

/**
 * Launch `filePath` in the user's editor, trying the configured editor, then
 * `$VISUAL`/`$EDITOR`, then whatever is discoverable, then the platform
 * launcher.
 *
 * A terminal-only editor is never launched: every launch here is detached with
 * its streams ignored, so it would start as a process nobody can see (#17441).
 * Automatic selection passes over one, as `$VISUAL`/`$EDITOR` already do, and a
 * configured one launches nothing and says so in the result, so the caller can
 * explain how to run it through a terminal app.
 *
 * `isDirectory` marks the target as a folder — the worktree "Open in Editor"
 * action opens one (#12329). Coordinates are meaningless there, so they are
 * dropped up front: that alone gives most editors their correct folder syntax,
 * since a bare path is what they already emit with no line. The two places a
 * folder still needs its own answer are the VS Code family's `--goto` and the
 * macOS `open -t` step, which forces the plain-text UTI handler and cannot open
 * a directory at all.
 */
export async function openFile(
  filePath: string,
  line?: number,
  col?: number,
  config?: EditorConfig | null,
  isDirectory = false
): Promise<SystemOpenInEditorNeedsTerminal | void> {
  if (!path.isAbsolute(filePath)) {
    throw new Error("Only absolute paths are allowed");
  }

  // A folder has no coordinates to navigate to, so they never reach a builder.
  const targetLine = isDirectory ? undefined : line;
  const targetCol = isDirectory ? undefined : col;

  const { execa } = await import("execa");

  const launchEditor = async (binary: string, args: string[]): Promise<boolean> => {
    const program = await launchProgram(binary);
    if (program === null) return false;
    try {
      const desktopEnv = linuxDesktopAppEnv();
      const child = execa(program, args, {
        detached: true,
        stdio: "ignore",
        cleanup: false,
        ...(desktopEnv ? { env: desktopEnv, extendEnv: false } : {}),
      });
      child.nodeChildProcess.unref();
      // Suppress unhandled async rejection from the detached process
      child.catch(() => {});
      // execa never throws synchronously for a broken command — ENOENT and
      // EACCES surface only as an async rejection, and its early-error path
      // hands back a dummy child that emits no events at all. Racing "spawned"
      // against the promise settling reads both channels, so a missing binary
      // reports failure and the fallback chain gets its turn. It cannot hang:
      // the promise always settles on the failure paths, and a GUI editor that
      // outlives us wins on 'spawn' long before its promise would settle.
      return await Promise.race([
        new Promise<boolean>((resolve) =>
          child.nodeChildProcess.once("spawn", () => resolve(true))
        ),
        child.then(
          () => true,
          () => false
        ),
      ]);
    } catch {
      return false;
    }
  };

  // 1. Try the configured editor
  if (config) {
    if (config.id === "custom") {
      const command = config.customCommand?.trim();
      const template = config.customTemplate?.trim() ?? "{file}";
      if (command) {
        const { binary, args } = buildCustomArgs(
          template,
          command,
          filePath,
          targetLine,
          targetCol
        );
        const launched = await launchEditor(binary, args);
        if (launched) return;
      }
    } else {
      const def = resolveEditorDef(config.id);
      const terminalCommand = def && terminalOnlyEditorCommand(def.id);
      if (def && terminalCommand) {
        return { outcome: "needs-terminal", editorName: def.name, command: terminalCommand };
      }
      if (def) {
        const executable = await findExecutable(def);
        if (executable) {
          const args = def.buildArgs(filePath, targetLine, targetCol, isDirectory);
          const launched = await launchEditor(executable, args);
          if (launched) return;
        }
      }
    }
  }

  // 2. Try VISUAL, then EDITOR. They're checked in order so a terminal-editor
  // VISUAL (e.g. VISUAL=vim) doesn't suppress a GUI-editor EDITOR (e.g. EDITOR=code).
  for (const envEditor of [process.env.VISUAL, process.env.EDITOR]) {
    if (!envEditor) continue;
    const launched = await tryEnvEditor(
      envEditor,
      filePath,
      targetLine,
      targetCol,
      isDirectory,
      launchEditor
    );
    if (launched) return;
  }

  // 3. Try discovered editors in priority order
  for (const def of KNOWN_EDITORS) {
    if (terminalOnlyEditorCommand(def.id)) continue;
    const executable = await findExecutable(def);
    if (executable) {
      const args = def.buildArgs(filePath, targetLine, targetCol, isDirectory);
      const launched = await launchEditor(executable, args);
      if (launched) return;
    }
  }

  // 4. macOS .app fallback (no line support). `-t` opens with the user's default
  // text editor (public.plain-text UTI handler) rather than the file-extension
  // association, so .ts/.tsx files don't route through Xcode/Cursor. That same
  // forcing is why a directory skips this step: a plain-text handler cannot
  // open a folder, so `open -t` would report success while showing nothing.
  if (process.platform === "darwin" && !isDirectory) {
    const launched = await launchEditor("open", ["-t", filePath]);
    if (launched) return;
  }

  // 5. shell.openPath as last resort — the OS default handler, which for a
  // directory means the file manager. Reaching it is the failure the worktree
  // action used to start from, so it stays strictly last.
  const errorString = await openWithDefaultApp(filePath);
  if (errorString) {
    throw new Error(`Failed to open file: ${errorString}`);
  }
}
