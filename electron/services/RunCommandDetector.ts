import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import type { RunCommand } from "../types/index.js";

const RESERVED_SCRIPT_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const SAFE_SCRIPT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_./-]*$/;

function isSafeScriptName(name: string): boolean {
  if (RESERVED_SCRIPT_NAMES.has(name)) {
    return false;
  }
  return SAFE_SCRIPT_NAME_PATTERN.test(name);
}

export class RunCommandDetector {
  async detect(projectPath: string): Promise<RunCommand[]> {
    const results = await Promise.all([
      this.detectNpm(projectPath),
      this.detectMakefile(projectPath),
      this.detectDjango(projectPath),
      this.detectComposer(projectPath),
    ]);

    return results.flat();
  }

  private async detectNpm(root: string): Promise<RunCommand[]> {
    const pkgPath = path.join(root, "package.json");
    if (!existsSync(pkgPath)) return [];

    try {
      const content = await fs.readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(content);
      if (!pkg.scripts || typeof pkg.scripts !== "object") return [];

      let runner = "npm run";
      if (existsSync(path.join(root, "bun.lockb"))) {
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
          const lifecycleScripts = [
            "pre-install-cmd",
            "post-install-cmd",
            "pre-update-cmd",
            "post-update-cmd",
            "post-autoload-dump",
            "pre-autoload-dump",
            "post-root-package-install",
            "post-create-project-cmd",
          ];
          if (lifecycleScripts.includes(name)) {
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
}

export const runCommandDetector = new RunCommandDetector();
