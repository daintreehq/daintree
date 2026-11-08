import path from "path";
import fs from "fs/promises";
import { load } from "js-yaml";
import { parse as parseToml } from "smol-toml";
import type { RunCommand } from "../types/index.js";
import { Cache } from "../utils/cache.js";
import { YAML_MERGE_SCHEMA } from "../utils/yamlMergeSchema.js";
import { stripUtf8Bom } from "../utils/stripUtf8Bom.js";
import { parseJsonc } from "../utils/parseJsonc.js";
import { agentCommandDialect, quoteLaunchArgOptional } from "../../shared/utils/shellEscape.js";
import { isProjectIoError, projectIo } from "./projectIoGate.js";

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

type NpmFrameworkSignature = {
  readonly packages: readonly string[];
  readonly canonicalScript: "dev" | "start";
  // The canonical script body must contain at least one of these tokens to
  // count as a match. Guards against repos that list a framework as a dep
  // but whose dev/start script does something unrelated (e.g. CRA listed in
  // deps but `start: "node server.js"`); without this we'd promote the wrong
  // script and regress vs. plain name-priority order.
  readonly bodyTokens: readonly RegExp[];
};

// Ordered most-specific to least-specific. Full-stack frameworks beat generic
// bundlers when multiple are present (e.g. a Next.js repo that also lists vite
// as a transitive devDep should still pick `next dev`).
const NPM_FRAMEWORK_PRIORITY: readonly NpmFrameworkSignature[] = [
  { packages: ["next"], canonicalScript: "dev", bodyTokens: [/\bnext\b/] },
  { packages: ["@remix-run/dev"], canonicalScript: "dev", bodyTokens: [/\bremix\b/] },
  { packages: ["@react-router/dev"], canonicalScript: "dev", bodyTokens: [/\breact-router\b/] },
  { packages: ["nuxt"], canonicalScript: "dev", bodyTokens: [/\bnuxt\b/, /\bnuxi\b/] },
  {
    packages: ["@sveltejs/kit"],
    canonicalScript: "dev",
    // SvelteKit v1 used `svelte-kit dev`; v2+ runs via `vite dev`.
    bodyTokens: [/\bvite\b/, /\bsvelte-kit\b/],
  },
  { packages: ["astro"], canonicalScript: "dev", bodyTokens: [/\bastro\b/] },
  { packages: ["react-scripts"], canonicalScript: "start", bodyTokens: [/\breact-scripts\b/] },
  { packages: ["vite"], canonicalScript: "dev", bodyTokens: [/\bvite\b/] },
];

function detectNpmFrameworkCanonicalScript(
  deps: Record<string, unknown> | undefined,
  devDeps: Record<string, unknown> | undefined,
  scripts: Record<string, unknown>
): "dev" | "start" | undefined {
  const hasDep = (name: string): boolean => {
    return (
      (typeof deps === "object" && deps !== null && name in deps) ||
      (typeof devDeps === "object" && devDeps !== null && name in devDeps)
    );
  };

  for (const signature of NPM_FRAMEWORK_PRIORITY) {
    if (!signature.packages.some(hasDep)) continue;
    const body = scripts[signature.canonicalScript];
    if (typeof body !== "string") continue;
    if (!signature.bodyTokens.some((re) => re.test(body))) continue;
    return signature.canonicalScript;
  }
  return undefined;
}

const JUSTFILE_VARIANTS = ["justfile", "Justfile", ".justfile", "JUSTFILE"];
const TASKFILE_VARIANTS = [
  "Taskfile.yml",
  "taskfile.yml",
  "Taskfile.yaml",
  "taskfile.yaml",
  "Taskfile.dist.yml",
  "taskfile.dist.yml",
  "Taskfile.dist.yaml",
  "taskfile.dist.yaml",
];

// Every file a detector reads or probes. Must stay in step with the detect*
// methods: a file missing here can change without invalidating the cache.
const DETECTION_INPUTS: readonly string[] = [
  "package.json",
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Makefile",
  ...JUSTFILE_VARIANTS,
  ...TASKFILE_VARIANTS,
  "Procfile",
  "mise.toml",
  "manage.py",
  "composer.json",
  path.join(".devcontainer", "devcontainer.json"),
];

/**
 * One detection pass over a project. Every file goes through the project I/O
 * gate (#16361), so a project whose files never finish reading (online-only
 * cloud placeholders, a dead mount) holds at most its own slot of Main's libuv
 * pool; a refused request marks the pass incomplete instead of failing it.
 */
class DetectionRun {
  incomplete = false;
  private readonly present = new Set<string>();

  constructor(readonly root: string) {}

  /**
   * Stats every detection input once: the signature the cache is checked
   * against, and the existence answers the detectors use instead of probing
   * the disk again.
   */
  async probe(): Promise<string> {
    const parts = await Promise.all(
      DETECTION_INPUTS.map(async (name) => {
        try {
          const stat = await projectIo.run(this.root, () => fs.stat(path.join(this.root, name)));
          this.present.add(name);
          return `${stat.mtimeMs}:${stat.size}`;
        } catch (error) {
          if (isProjectIoError(error)) this.incomplete = true;
          return "-";
        }
      })
    );
    return parts.join("|");
  }

  has(name: string): boolean {
    return this.present.has(name);
  }

  /** The file's text, or null when the gate refused the read. */
  async read(name: string): Promise<string | null> {
    try {
      return await projectIo.run(this.root, () => fs.readFile(path.join(this.root, name), "utf-8"));
    } catch (error) {
      if (!isProjectIoError(error)) throw error;
      this.incomplete = true;
      return null;
    }
  }
}

interface CachedDetection {
  signature: string;
  commands: RunCommand[];
}

export class RunCommandDetector {
  private readonly cache = new Cache<string, CachedDetection>({
    maxSize: 50,
    defaultTTL: 60_000,
  });

  async detect(projectPath: string): Promise<RunCommand[]> {
    // A project is often added before it is scaffolded, so a cached result is
    // only reused while none of the files it was derived from has changed.
    const run = new DetectionRun(projectPath);
    const signature = await run.probe();
    const cached = this.cache.get(projectPath);
    // A pass that couldn't stat everything can't validate the cache, so the
    // last full result is the better answer than a partial one.
    if (cached && (run.incomplete || cached.signature === signature)) return cached.commands;

    const results = await Promise.all([
      this.detectNpm(run),
      this.detectMakefile(run),
      this.detectJustfile(run),
      this.detectTaskfile(run),
      this.detectProcfile(run),
      this.detectMise(run),
      this.detectDjango(run),
      this.detectComposer(run),
      this.detectDevContainer(run),
    ]);

    const commands = results.flat();
    // A partial result must not outlive the stall that caused it.
    if (!run.incomplete) this.cache.set(projectPath, { signature, commands });
    return commands;
  }

  private async detectNpm(run: DetectionRun): Promise<RunCommand[]> {
    const pkgPath = path.join(run.root, "package.json");
    if (!run.has("package.json")) return [];

    try {
      const content = await run.read("package.json");
      if (content === null) return [];
      const pkg = JSON.parse(stripUtf8Bom(content));
      if (!pkg.scripts || typeof pkg.scripts !== "object") return [];

      let runner = "npm run";
      if (run.has("bun.lock")) {
        runner = "bun run";
      } else if (run.has("bun.lockb")) {
        runner = "bun run";
      } else if (run.has("pnpm-lock.yaml")) {
        runner = "pnpm run";
      } else if (run.has("yarn.lock")) {
        runner = "yarn run";
      }

      const commands: RunCommand[] = Object.entries(pkg.scripts)
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

      const canonicalScript = detectNpmFrameworkCanonicalScript(
        pkg.dependencies,
        pkg.devDependencies,
        pkg.scripts as Record<string, unknown>
      );
      if (canonicalScript) {
        const idx = commands.findIndex((cmd) => cmd.name === canonicalScript);
        if (idx >= 0) {
          commands[idx] = { ...commands[idx], isFrameworkDefault: true };
          if (idx > 0) {
            const [promoted] = commands.splice(idx, 1);
            commands.unshift(promoted);
          }
        }
      }

      return commands;
    } catch (error) {
      console.warn(`[RunCommandDetector] Failed to parse ${pkgPath}:`, error);
      return [];
    }
  }

  private async detectMakefile(run: DetectionRun): Promise<RunCommand[]> {
    const makePath = path.join(run.root, "Makefile");
    if (!run.has("Makefile")) return [];

    try {
      const content = await run.read("Makefile");
      if (content === null) return [];
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

  private async detectJustfile(run: DetectionRun): Promise<RunCommand[]> {
    const justfileName = JUSTFILE_VARIANTS.find((name) => run.has(name));
    if (!justfileName) return [];
    const justfilePath = path.join(run.root, justfileName);

    try {
      const content = await run.read(justfileName);
      if (content === null) return [];
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

  private async detectTaskfile(run: DetectionRun): Promise<RunCommand[]> {
    const taskfileName = TASKFILE_VARIANTS.find((name) => run.has(name));
    if (!taskfileName) return [];
    const taskfilePath = path.join(run.root, taskfileName);

    try {
      const content = await run.read(taskfileName);
      if (content === null) return [];
      // Merge schema: Taskfiles share `desc`/`internal` across tasks via anchors,
      // and without it a task inheriting `desc` vanishes from the run list while
      // one inheriting `internal: true` leaks into it.
      const doc = load(content, { schema: YAML_MERGE_SCHEMA }) as Record<string, unknown> | null;
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

  private async detectProcfile(run: DetectionRun): Promise<RunCommand[]> {
    const procfilePath = path.join(run.root, "Procfile");
    if (!run.has("Procfile")) return [];

    try {
      const content = await run.read("Procfile");
      if (content === null) return [];
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

  private async detectMise(run: DetectionRun): Promise<RunCommand[]> {
    const misePath = path.join(run.root, "mise.toml");
    if (!run.has("mise.toml")) return [];

    try {
      const content = await run.read("mise.toml");
      if (content === null) return [];
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

  private async detectDjango(run: DetectionRun): Promise<RunCommand[]> {
    if (!run.has("manage.py")) return [];

    const commonCommands = ["runserver", "migrate", "makemigrations", "test", "shell"];

    const pythonBin = process.platform === "win32" ? "python" : "python3";

    return commonCommands.map((cmd) => ({
      id: `django-${cmd}`,
      name: `Django ${cmd}`,
      command: `${pythonBin} manage.py ${cmd}`,
      icon: "python",
    }));
  }

  private async detectComposer(run: DetectionRun): Promise<RunCommand[]> {
    const composerPath = path.join(run.root, "composer.json");
    if (!run.has("composer.json")) return [];

    try {
      const content = await run.read("composer.json");
      if (content === null) return [];
      const json = JSON.parse(stripUtf8Bom(content));
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
  private async detectDevContainer(run: DetectionRun): Promise<RunCommand[]> {
    const devcontainerName = path.join(".devcontainer", "devcontainer.json");
    const devcontainerPath = path.join(run.root, devcontainerName);
    if (!run.has(devcontainerName)) return [];

    try {
      const content = await run.read(devcontainerName);
      if (content === null) return [];
      const config = parseJsonc(content) as { postStartCommand?: unknown } | null;
      const postStart = config?.postStartCommand;
      if (postStart === undefined || postStart === null) return [];

      let command: string | undefined;

      if (typeof postStart === "string") {
        command = this.stripShellWrappers(postStart);
      } else if (Array.isArray(postStart)) {
        command = this.argvToCommand(postStart);
      } else if (typeof postStart === "object" && postStart !== null) {
        const keys = Object.keys(postStart as Record<string, unknown>);
        if (keys.length > 0) {
          const isValidVal = (v: unknown): boolean =>
            (typeof v === "string" && v.trim().length > 0) ||
            (Array.isArray(v) && this.argvToCommand(v) !== undefined);

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
              command = this.stripShellWrappers(val);
            } else if (Array.isArray(val)) {
              command = this.argvToCommand(val);
            }
          }
        }
      }

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

  /**
   * Array lifecycle commands are exec'd without a shell, but the detected
   * command runs through one, so every token is quoted to survive intact.
   * Wrapper stripping happens on tokens: a quoted `'&'` is a literal argument.
   */
  private argvToCommand(items: unknown[]): string | undefined {
    if (!items.every((item): item is string => typeof item === "string")) return undefined;
    let argv: string[] = items;

    if (argv[0] === "nohup") argv = argv.slice(1);

    // Keep the named interpreter: the host shell may not run a bash script the same way.
    if (argv.length === 3 && (argv[0] === "bash" || argv[0] === "sh") && argv[1] === "-c") {
      const script = this.stripShellWrappers(argv[2]);
      if (script.length === 0) return undefined;
      argv = [argv[0], "-c", script];
    }

    if (argv.length === 0 || argv[0].length === 0) return undefined;

    const dialect = agentCommandDialect();
    const quoted = argv.map((arg) => quoteLaunchArgOptional(arg, dialect));
    // PowerShell treats a quoted first token as a string expression, not a command.
    if (dialect === "windows" && quoted[0] !== argv[0]) quoted[0] = `& ${quoted[0]}`;
    return quoted.join(" ");
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
