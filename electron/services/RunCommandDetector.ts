import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { load } from "js-yaml";
import { parse as parseToml } from "smol-toml";
import type { RunCommand } from "../types/index.js";
import { Cache } from "../utils/cache.js";

const RESERVED_SCRIPT_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const COMPOSER_LIFECYCLE_SCRIPTS = new Set([
  "pre-install-cmd",
  "post-install-cmd",
  "pre-update-cmd",
  "post-update-cmd",
  "post-autoload-dump",
  "pre-autoload-dump",
  "post-root-package-install",
  "post-create-project-cmd",
]);
const SAFE_SCRIPT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_./-]*$/;

function isSafeScriptName(name: string): boolean {
  if (RESERVED_SCRIPT_NAMES.has(name)) {
    return false;
  }
  return SAFE_SCRIPT_NAME_PATTERN.test(name);
}

export class RunCommandDetector {
  private readonly cache = new Cache<string, RunCommand[]>({
    maxSize: 50,
    defaultTTL: 60_000,
  });

  async detect(projectPath: string): Promise<RunCommand[]> {
    const cached = this.cache.get(projectPath);
    if (cached) return cached;

    const results = await Promise.all([
      this.detectNpm(projectPath),
      this.detectMakefile(projectPath),
      this.detectJustfile(projectPath),
      this.detectTaskfile(projectPath),
      this.detectProcfile(projectPath),
      this.detectMise(projectPath),
      this.detectDjango(projectPath),
      this.detectComposer(projectPath),
      this.detectDevContainer(projectPath),
    ]);

    const commands = results.flat();
    this.cache.set(projectPath, commands);
    return commands;
  }

  private async detectNpm(root: string): Promise<RunCommand[]> {
    const pkgPath = path.join(root, "package.json");
    if (!existsSync(pkgPath)) return [];

    try {
      const content = await fs.readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(content);
      if (!pkg.scripts || typeof pkg.scripts !== "object") return [];

      let runner = "npm run";
      if (existsSync(path.join(root, "bun.lock"))) {
        runner = "bun run";
      } else if (existsSync(path.join(root, "bun.lockb"))) {
        runner = "bun run";
      } else if (existsSync(path.join(root, "pnpm-lock.yaml"))) {
        runner = "pnpm run";
      } else if (existsSync(path.join(root, "yarn.lock"))) {
        runner = "yarn";
      }

      return Object.entries(pkg.scripts)
        .filter(([name, script]) => {
          if (typeof script !== "string") {
            return false;
          }
          if (!isSafeScriptName(name)) {
            console.warn(`[RunCommandDetector] Skipping npm script with unsafe name: ${name}`);
            return false;
          }
          return true;
        })
        .map(([name, script]) => ({
          id: `npm-${name}`,
          name,
          command: `${runner} ${name}`,
          icon: "npm",
          description: script as string,
        }));
    } catch (error) {
      console.warn(`[RunCommandDetector] Failed to parse ${pkgPath}:`, error);
      return [];
    }
  }

  private async detectMakefile(root: string): Promise<RunCommand[]> {
    const makePath = path.join(root, "Makefile");
    if (!existsSync(makePath)) return [];

    try {
      const content = await fs.readFile(makePath, "utf-8");
      const targetRegex = /^([A-Za-z0-9][\w.+/-]*(?:\s+[A-Za-z0-9][\w.+/-]*)*)\s*:(?![=])/gm;
      const commands: RunCommand[] = [];
      const seen = new Set<string>();

      let match;
      while ((match = targetRegex.exec(content)) !== null) {
        const targets = match[1].trim().split(/\s+/);
        for (const target of targets) {
          if (target.startsWith(".") || target === "PHONY" || seen.has(target)) {
            continue;
          }
          seen.add(target);
          commands.push({
            id: `make-${target}`,
            name: `make ${target}`,
            command: `make ${target}`,
            icon: "terminal",
          });
        }
      }
      return commands;
    } catch (error) {
      console.warn(`[RunCommandDetector] Failed to parse ${makePath}:`, error);
      return [];
    }
  }

  private async detectJustfile(root: string): Promise<RunCommand[]> {
    const variants = ["justfile", "Justfile", ".justfile", "JUSTFILE"];
    let justfilePath: string | null = null;
    for (const name of variants) {
      const candidate = path.join(root, name);
      if (existsSync(candidate)) {
        justfilePath = candidate;
        break;
      }
    }
    if (!justfilePath) return [];

    try {
      const content = await fs.readFile(justfilePath, "utf-8");
      const lines = content.split("\n");
      const commands: RunCommand[] = [];
      const seen = new Set<string>();

      const recipeRegex = /^@?([a-zA-Z_.][a-zA-Z0-9._-]*)\s*(?:[^:=][^:]*)?\s*:(?!=)/;
      const keywordPrefixes = ["alias ", "set ", "import ", "mod ", "export "];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (keywordPrefixes.some((kw) => line.startsWith(kw))) continue;
        if (line.includes(":=")) continue;

        const match = recipeRegex.exec(line);
        if (!match) continue;

        const name = match[1];
        if (name.startsWith("_") || seen.has(name)) continue;
        if (!isSafeScriptName(name)) continue;

        seen.add(name);

        let description: string | undefined;
        for (let j = i - 1; j >= 0; j--) {
          const prev = lines[j].trim();
          if (prev.startsWith("[")) continue;
          if (prev.startsWith("#")) {
            description = prev.replace(/^#\s*/, "");
          }
          break;
        }

        commands.push({
          id: `just-${name}`,
          name,
          command: `just ${name}`,
          icon: "terminal",
          description,
        });
      }

      return commands;
    } catch (error) {
      console.warn(`[RunCommandDetector] Failed to parse ${justfilePath}:`, error);
      return [];
    }
  }

  private async detectTaskfile(root: string): Promise<RunCommand[]> {
    const variants = [
      "Taskfile.yml",
      "taskfile.yml",
      "Taskfile.yaml",
      "taskfile.yaml",
      "Taskfile.dist.yml",
      "taskfile.dist.yml",
      "Taskfile.dist.yaml",
      "taskfile.dist.yaml",
    ];
    let taskfilePath: string | null = null;
    for (const name of variants) {
      const candidate = path.join(root, name);
      if (existsSync(candidate)) {
        taskfilePath = candidate;
        break;
      }
    }
    if (!taskfilePath) return [];

    try {
      const content = await fs.readFile(taskfilePath, "utf-8");
      const doc = load(content) as Record<string, unknown> | null;
      if (!doc || typeof doc !== "object") return [];

      const tasks = doc.tasks;
      if (!tasks || typeof tasks !== "object" || Array.isArray(tasks)) return [];

      const commands: RunCommand[] = [];

      for (const [name, def] of Object.entries(tasks as Record<string, unknown>)) {
        if (name.startsWith("_")) continue;
        if (!isSafeScriptName(name)) continue;
        if (typeof def === "string") continue;
        if (typeof def !== "object" || def === null) continue;

        const taskDef = def as Record<string, unknown>;
        if (taskDef.internal === true) continue;
        if (typeof taskDef.desc !== "string") continue;

        commands.push({
          id: `task-${name}`,
          name,
          command: `task ${name}`,
          icon: "terminal",
          description: taskDef.desc,
        });
      }

      return commands;
    } catch (error) {
      console.warn(`[RunCommandDetector] Failed to parse ${taskfilePath}:`, error);
      return [];
    }
  }

  private async detectProcfile(root: string): Promise<RunCommand[]> {
    const procfilePath = path.join(root, "Procfile");
    if (!existsSync(procfilePath)) return [];

    try {
      const content = await fs.readFile(procfilePath, "utf-8");
      const lines = content.split("\n");
      const commands: RunCommand[] = [];
      const seen = new Set<string>();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        const match = /^([A-Za-z0-9_-]+):\s*(.+)$/.exec(trimmed);
        if (!match) continue;

        const name = match[1];
        const commandBody = match[2].trim();
        if (!commandBody || seen.has(name)) continue;
        if (!isSafeScriptName(name)) continue;

        seen.add(name);
        commands.push({
          id: `procfile-${name}`,
          name,
          command: commandBody,
          icon: "terminal",
        });
      }

      return commands;
    } catch (error) {
      console.warn(`[RunCommandDetector] Failed to parse ${procfilePath}:`, error);
      return [];
    }
  }

  private async detectMise(root: string): Promise<RunCommand[]> {
    const misePath = path.join(root, "mise.toml");
    if (!existsSync(misePath)) return [];

    try {
      const content = await fs.readFile(misePath, "utf-8");
      const doc = parseToml(content) as Record<string, unknown> | null;
      if (!doc || typeof doc !== "object") return [];

      const tasks = doc.tasks;
      if (!tasks || typeof tasks !== "object" || Array.isArray(tasks)) return [];

      const commands: RunCommand[] = [];

      for (const [name, def] of Object.entries(tasks as Record<string, unknown>)) {
        if (name.startsWith("_")) continue;
        if (!isSafeScriptName(name)) continue;

        if (typeof def === "string") {
          commands.push({
            id: `mise-${name}`,
            name,
            command: `mise run ${name}`,
            icon: "terminal",
            description: def,
          });
          continue;
        }

        if (typeof def !== "object" || def === null) continue;

        const taskDef = def as Record<string, unknown>;
        if (taskDef.hide === true) continue;

        const run = taskDef.run;
        if (!run) continue;
        if (typeof run !== "string" && !Array.isArray(run)) continue;
        if (
          Array.isArray(run) &&
          (run.length === 0 || !run.every((v): v is string => typeof v === "string"))
        )
          continue;

        const desc = typeof taskDef.description === "string" ? taskDef.description : undefined;

        commands.push({
          id: `mise-${name}`,
          name,
          command: `mise run ${name}`,
          icon: "terminal",
          description: desc,
        });
      }

      return commands;
    } catch (error) {
      console.warn(`[RunCommandDetector] Failed to parse ${misePath}:`, error);
      return [];
    }
  }

  private async detectDjango(root: string): Promise<RunCommand[]> {
    if (!existsSync(path.join(root, "manage.py"))) return [];

    const commonCommands = ["runserver", "migrate", "makemigrations", "test", "shell"];

    const pythonBin = process.platform === "win32" ? "python" : "python3";

    return commonCommands.map((cmd) => ({
      id: `django-${cmd}`,
      name: `Django ${cmd}`,
      command: `${pythonBin} manage.py ${cmd}`,
      icon: "python",
    }));
  }

  private async detectComposer(root: string): Promise<RunCommand[]> {
    const composerPath = path.join(root, "composer.json");
    if (!existsSync(composerPath)) return [];

    try {
      const content = await fs.readFile(composerPath, "utf-8");
      const json = JSON.parse(content);
      if (!json.scripts || typeof json.scripts !== "object") return [];

      return Object.keys(json.scripts)
        .filter((name) => {
          if (COMPOSER_LIFECYCLE_SCRIPTS.has(name)) {
            return false;
          }
          if (!isSafeScriptName(name)) {
            console.warn(`[RunCommandDetector] Skipping composer script with unsafe name: ${name}`);
            return false;
          }
          return true;
        })
        .map((name) => ({
          id: `composer-${name}`,
          name: `composer ${name}`,
          command: `composer run-script ${name}`,
          icon: "php",
        }));
    } catch (error) {
      console.warn(`[RunCommandDetector] Failed to parse ${composerPath}:`, error);
      return [];
    }
  }
  private async detectDevContainer(root: string): Promise<RunCommand[]> {
    const devcontainerPath = path.join(root, ".devcontainer", "devcontainer.json");
    if (!existsSync(devcontainerPath)) return [];

    try {
      const content = await fs.readFile(devcontainerPath, "utf-8");
      const config = JSON.parse(content);
      const postStart = config.postStartCommand;
      if (postStart === undefined || postStart === null) return [];

      let command: string | undefined;

      if (typeof postStart === "string") {
        command = postStart.trim();
      } else if (Array.isArray(postStart)) {
        command = postStart
          .filter((item): item is string => typeof item === "string")
          .join(" ")
          .trim();
      } else if (typeof postStart === "object" && postStart !== null) {
        const keys = Object.keys(postStart as Record<string, unknown>);
        if (keys.length > 0) {
          const isValidVal = (v: unknown): boolean =>
            (typeof v === "string" && v.trim().length > 0) || Array.isArray(v);

          const keyPriority = ["server", "dev", "start", "app"];
          const bestKey =
            keyPriority.find((k) => {
              const v = (postStart as Record<string, unknown>)[k];
              return isValidVal(v);
            }) ??
            keys.find((k) => {
              const v = (postStart as Record<string, unknown>)[k];
              return isValidVal(v);
            });
          if (bestKey) {
            const val = (postStart as Record<string, unknown>)[bestKey];
            if (typeof val === "string") {
              command = val.trim();
            } else if (Array.isArray(val)) {
              command = val
                .filter((item): item is string => typeof item === "string")
                .join(" ")
                .trim();
            }
          }
        }
      }

      if (!command || command.length === 0) return [];

      command = this.stripShellWrappers(command);
      if (!command || command.length === 0) return [];

      return [
        {
          id: "devcontainer-poststart",
          name: "postStartCommand",
          command,
          icon: "terminal",
          description: "from .devcontainer/devcontainer.json",
        },
      ];
    } catch (error) {
      console.warn(`[RunCommandDetector] Failed to parse ${devcontainerPath}:`, error);
      return [];
    }
  }

  private stripShellWrappers(command: string): string {
    let result = command.trim();

    if (result.startsWith("nohup ")) {
      result = result.slice(6).trim();
    }

    if (result.endsWith(" &")) {
      result = result.slice(0, -2).trim();
    }

    const bashCMatch = result.match(/^(?:bash|sh)\s+-c\s+'([^']*)'$/);
    if (bashCMatch) {
      result = bashCMatch[1].trim();
      if (result.endsWith(" &")) {
        result = result.slice(0, -2).trim();
      }
    }

    return result;
  }
}

export const runCommandDetector = new RunCommandDetector();
