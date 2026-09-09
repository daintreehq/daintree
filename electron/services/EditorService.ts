import fs from "fs";
import path from "path";
import os from "os";
import { shell } from "electron";
import type { EditorConfig, DiscoveredEditor, KnownEditorId } from "../../shared/types/editor.js";

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
  {
    id: "webstorm",
    name: "WebStorm / IntelliJ",
    binaries: [
      "webstorm",
      "idea",
      "phpstorm",
      "pycharm",
      "goland",
      "rider",
      "clion",
      "datagrip",
      "rubymine",
    ],
    extraDirs: () => [
      ...jetbrainsToolboxScriptDirs(),
      ...macAppBundleDirs([
        { name: "WebStorm" },
        { name: "IntelliJ IDEA" },
        { name: "IntelliJ IDEA CE" },
        { name: "PhpStorm" },
        { name: "PyCharm" },
        { name: "PyCharm CE" },
        { name: "GoLand" },
        { name: "Rider" },
        { name: "CLion" },
        { name: "DataGrip" },
        { name: "RubyMine" },
      ]),
    ],
    buildArgs(filePath, line) {
      if (line !== undefined) {
        return ["--line", String(line), filePath];
      }
      return [filePath];
    },
  },
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
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    dirs.push(path.join(localAppData, "JetBrains", "Toolbox", "scripts"));
  }
  return dirs;
}

function findBinaryInPath(binary: string, extraDirs: string[] = []): string | null {
  const p = process.platform === "win32" ? path.win32 : path.posix;
  const pathDirs = (process.env.PATH ?? "").split(p.delimiter).filter(Boolean);
  const searchDirs = [...extraDirs, ...pathDirs];

  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase())
      : [""];

  for (const dir of searchDirs) {
    for (const ext of extensions) {
      const fullPath = p.join(dir, binary + ext);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;
        if (process.platform === "win32") return fullPath;
        try {
          fs.accessSync(fullPath, fs.constants.X_OK);
          return fullPath;
        } catch {
          // not executable for this user, continue
        }
      } catch {
        // not found, continue
      }
    }
  }
  return null;
}

function resolveEditorDef(id: KnownEditorId): EditorDefinition | undefined {
  return KNOWN_EDITORS.find((e) => e.id === id);
}

function findExecutable(def: EditorDefinition): string | null {
  const extraDirs = def.extraDirs ? def.extraDirs() : [];
  for (const binary of def.binaries) {
    const resolved = findBinaryInPath(binary, extraDirs);
    if (resolved) return resolved;
  }
  return null;
}

export function discover(): DiscoveredEditor[] {
  return KNOWN_EDITORS.map((def) => {
    const executablePath = findExecutable(def) ?? undefined;
    return {
      id: def.id,
      name: def.name,
      available: executablePath !== undefined,
      executablePath,
    };
  });
}

/**
 * A placeholder together with the separator that introduces it, so an absent
 * coordinate takes its own punctuation with it. `:` is the documented form
 * (`{file}:{line}:{col}`); `,` and `+` cover the other conventions users write
 * by hand.
 */
const CUSTOM_PLACEHOLDER = /([:,+])?\{(file|line|col)\}/g;

type CustomPlaceholder = "file" | "line" | "col";

/**
 * Interpolate a custom-editor template, dropping the punctuation an absent
 * coordinate would otherwise strand. The settings UI defaults the template to
 * `{file}:{line}:{col}`, so without this a target with no line renders
 * `/path/to/thing::` — which every editor treats as a different, missing file.
 * That is unconditional for a directory (folders have no coordinates) and was
 * already reachable for any file opened without one.
 *
 * Only punctuation *inside* a token is dropped, and the token itself always
 * survives — a template can be positional (`"{line}" "{col}" "{file}"`), where
 * removing an empty argument would slide the path into the column's slot. For
 * the same reason a flag token that names a coordinate (`--line {line}`) is
 * left standing: guessing which of a user's own arguments were only there to
 * carry a line is not something this can do safely.
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
  if (process.platform === "win32" && name.endsWith(".exe")) {
    name = name.slice(0, -".exe".length);
  }
  return name;
}

async function tryEnvEditor(
  envEditor: string,
  filePath: string,
  launchEditor: (binary: string, args: string[]) => Promise<boolean>
): Promise<boolean> {
  const tokens = tokenizeArgString(envEditor);
  if (tokens.length === 0) return false;
  const [binary, ...extraArgs] = tokens;
  // Skip terminal editors — spawning them detached + stdio:"ignore" produces an
  // invisible hung process. Fall through to GUI-capable fallbacks instead.
  if (TERMINAL_EDITORS.has(envEditorBinaryName(binary))) return false;
  return launchEditor(binary, [...extraArgs, filePath]);
}

/**
 * Launch `filePath` in the user's editor, trying the configured editor, then
 * `$VISUAL`/`$EDITOR`, then whatever is discoverable, then the platform
 * launcher.
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
): Promise<void> {
  if (!path.isAbsolute(filePath)) {
    throw new Error("Only absolute paths are allowed");
  }

  // A folder has no coordinates to navigate to, so they never reach a builder.
  const targetLine = isDirectory ? undefined : line;
  const targetCol = isDirectory ? undefined : col;

  const { execa } = await import("execa");

  const launchEditor = async (binary: string, args: string[]): Promise<boolean> => {
    try {
      const child = execa(binary, args, {
        detached: true,
        stdio: "ignore",
        cleanup: false,
      });
      child.unref();
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
        new Promise<boolean>((resolve) => child.once("spawn", () => resolve(true))),
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
      if (def) {
        const executable = findExecutable(def);
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
    const launched = await tryEnvEditor(envEditor, filePath, launchEditor);
    if (launched) return;
  }

  // 3. Try discovered editors in priority order
  for (const def of KNOWN_EDITORS) {
    const executable = findExecutable(def);
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
  const errorString = await shell.openPath(filePath);
  if (errorString) {
    throw new Error(`Failed to open file: ${errorString}`);
  }
}
