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
  /** Build the argv for opening a file at line/col */
  buildArgs(filePath: string, line?: number, col?: number): string[];
}

const KNOWN_EDITORS: EditorDefinition[] = [
  {
    id: "vscode",
    name: "VS Code",
    binaries: ["code"],
    extraDirs: () =>
      macAppBundleDirs([{ name: "Visual Studio Code", subPath: "Contents/Resources/app/bin" }]),
    buildArgs(filePath, line, col) {
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
    buildArgs(filePath, line, col) {
      const target =
        line !== undefined ? `${filePath}:${line}${col !== undefined ? `:${col}` : ""}` : filePath;
      return ["--goto", target];
    },
  },
  {
    id: "cursor",
    name: "Cursor",
    binaries: ["cursor"],
    extraDirs: () =>
      macAppBundleDirs([{ name: "Cursor", subPath: "Contents/Resources/app/bin" }]),
    buildArgs(filePath, line, col) {
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
    buildArgs(filePath, line, col) {
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
    binaries: ["webstorm", "idea", "phpstorm", "pycharm", "goland", "rider", "clion", "datagrip", "rubymine"],
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
];

function macAppBundleDirs(
  apps: Array<{ name: string; subPath?: string }>
): string[] {
  if (process.platform !== "darwin") return [];
  const dirs: string[] = [];
  for (const { name, subPath = "Contents/MacOS" } of apps) {
    dirs.push(path.join("/Applications", `${name}.app`, subPath));
    dirs.push(path.join(os.homedir(), "Applications", `${name}.app`, subPath));
  }
  return dirs;
}

function jetbrainsToolboxScriptDirs(): string[] {
  const dirs: string[] = [];
  if (process.platform === "darwin") {
    dirs.push(
      path.join(os.homedir(), "Library", "Application Support", "JetBrains", "Toolbox", "scripts")
    );
  } else if (process.platform === "linux") {
    dirs.push(path.join(os.homedir(), ".local", "share", "JetBrains", "Toolbox", "scripts"));
  } else if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    dirs.push(path.join(localAppData, "JetBrains", "Toolbox", "scripts"));
  }
  return dirs;
}

function findBinaryInPath(binary: string, extraDirs: string[] = []): string | null {
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const searchDirs = [...extraDirs, ...pathDirs];

  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase())
      : [""];

  for (const dir of searchDirs) {
    for (const ext of extensions) {
      const fullPath = path.join(dir, binary + ext);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) return fullPath;
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

function buildCustomArgs(
  template: string,
  command: string,
  filePath: string,
  line?: number,
  col?: number
): { binary: string; args: string[] } {
  const lineStr = line !== undefined ? String(line) : "";
  const colStr = col !== undefined ? String(col) : "";
  const expanded = template
    .replace("{file}", filePath)
    .replace("{line}", lineStr)
    .replace("{col}", colStr);

  // Parse expanded template into argv (simple split on whitespace, no shell)
  const parts = expanded.trim().split(/\s+/).filter(Boolean);
  return { binary: command, args: parts };
}

export async function openFile(
  filePath: string,
  line?: number,
  col?: number,
  config?: EditorConfig | null
): Promise<void> {
  if (!path.isAbsolute(filePath)) {
    throw new Error("Only absolute paths are allowed");
  }

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
      return true;
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
        const { binary, args } = buildCustomArgs(template, command, filePath, line, col);
        const launched = await launchEditor(binary, args);
        if (launched) return;
      }
    } else {
      const def = resolveEditorDef(config.id);
      if (def) {
        const executable = findExecutable(def);
        if (executable) {
          const args = def.buildArgs(filePath, line, col);
          const launched = await launchEditor(executable, args);
          if (launched) return;
        }
      }
    }
  }

  // 2. Try VISUAL / EDITOR env vars
  const envEditor = process.env.VISUAL || process.env.EDITOR;
  if (envEditor) {
    const launched = await launchEditor(envEditor, [filePath]);
    if (launched) return;
  }

  // 3. Try discovered editors in priority order
  for (const def of KNOWN_EDITORS) {
    const executable = findExecutable(def);
    if (executable) {
      const args = def.buildArgs(filePath, line, col);
      const launched = await launchEditor(executable, args);
      if (launched) return;
    }
  }

  // 4. macOS .app fallback (no line support)
  if (process.platform === "darwin") {
    try {
      const child = execa("open", [filePath], {
        detached: true,
        stdio: "ignore",
        cleanup: false,
      });
      child.unref();
      return;
    } catch {
      // fall through
    }
  }

  // 5. shell.openPath as last resort
  const errorString = await shell.openPath(filePath);
  if (errorString) {
    throw new Error(`Failed to open file: ${errorString}`);
  }
}
