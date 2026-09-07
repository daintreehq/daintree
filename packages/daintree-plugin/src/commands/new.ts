import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as p from "@clack/prompts";
import { SCOPED_PLUGIN_NAME_PATTERN } from "../../../../electron/schemas/plugin.js";
import {
  buildProjectRecipe,
  buildTemplateFiles,
  projectPluginRelDir,
  TEMPLATE_KINDS,
  type ScaffoldContext,
  type TemplateKind,
} from "../scaffold/templates.js";

/** A single publisher/plugin name segment (the half on either side of the dot). */
const SEGMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Mirrors the manifest schema's `name` cap in `electron/schemas/plugin.ts`. */
const MAX_PLUGIN_NAME_LENGTH = 64;

export interface ScaffoldPluginOptions {
  /** Parent directory the plugin folder is created under (installed plugins). */
  cwd: string;
  /** Folder name; doubles as the plugin segment of the scoped name. */
  targetDir: string;
  publisher: string;
  displayName: string;
  template: TemplateKind;
  /**
   * Scaffold a project-local plugin instead. The plugin is written to
   * `<projectRoot>/.daintree/plugins/<publisher.name>/` — named after the
   * manifest, which is what discovery expects — and a build-watcher recipe is
   * written to `<projectRoot>/.daintree/recipes/`. `cwd` is ignored in this mode.
   */
  projectRoot?: string;
}

export interface ScaffoldResult {
  dir: string;
  scopedName: string;
  /** Paths relative to `dir`, sorted. */
  files: string[];
  /** Absolute path of the watcher recipe, for a project-local scaffold only. */
  recipePath?: string;
}

function segmentError(value: string, label: string): string | null {
  if (!SEGMENT_PATTERN.test(value)) {
    return `${label} must be lowercase letters, digits, and single hyphens (e.g. "acme" or "issue-helper")`;
  }
  return null;
}

/**
 * Write a plugin project from a template. Does no prompting — `runNew` handles
 * interactivity, this is the unit-testable core. Refuses to write into an
 * existing directory (Tier D1: never silently clobber an author's work).
 */
export async function scaffoldPlugin(opts: ScaffoldPluginOptions): Promise<ScaffoldResult> {
  const pubErr = segmentError(opts.publisher, "Publisher");
  if (pubErr) throw new Error(pubErr);
  const nameErr = segmentError(opts.targetDir, "Plugin name");
  if (nameErr) throw new Error(nameErr);

  const scopedName = `${opts.publisher}.${opts.targetDir}`;
  if (!SCOPED_PLUGIN_NAME_PATTERN.test(scopedName)) {
    throw new Error(`"${scopedName}" is not a valid plugin name (expected publisher.name)`);
  }
  // The manifest schema caps `name` at 64 characters. Without this the scaffold
  // happily writes a manifest the host would reject, and the author only finds
  // out at `daintree-plugin validate`.
  if (scopedName.length > MAX_PLUGIN_NAME_LENGTH) {
    throw new Error(
      `"${scopedName}" is ${scopedName.length} characters; a plugin name may be at most ${MAX_PLUGIN_NAME_LENGTH}`
    );
  }

  const projectRoot = opts.projectRoot;
  const projectLocal = projectRoot !== undefined;
  // Project-local plugins are keyed by the manifest name, so the directory is
  // named after it. Both name segments are already validated against
  // SEGMENT_PATTERN (lowercase alphanumerics and single hyphens), so the scoped
  // name cannot contain a separator, a leading dot, or `..` — the join stays
  // inside the project root by construction.
  const dir =
    projectRoot !== undefined
      ? path.resolve(projectRoot, projectPluginRelDir(scopedName))
      : path.resolve(opts.cwd, opts.targetDir);
  const dirExists = await fs
    .access(dir)
    .then(() => true)
    .catch(() => false);
  if (dirExists) {
    throw new Error(`Directory already exists: ${dir}`);
  }

  const ctx: ScaffoldContext = {
    scopedName,
    publisher: opts.publisher,
    pluginName: opts.targetDir,
    displayName: opts.displayName,
    template: opts.template,
    projectLocal,
  };
  const files = buildTemplateFiles(ctx);

  // The recipe lands outside the plugin directory, so check it before writing
  // anything: a half-scaffolded plugin with no watcher is worse than a clean
  // refusal, and clobbering a recipe an author already wrote is not ours to do.
  const recipe =
    projectRoot !== undefined
      ? buildProjectRecipe(ctx, { id: randomUUID(), createdAt: Date.now() })
      : null;
  const recipePath =
    recipe && projectRoot !== undefined ? path.resolve(projectRoot, recipe.relPath) : undefined;
  if (recipePath) {
    const recipeExists = await fs
      .access(recipePath)
      .then(() => true)
      .catch(() => false);
    if (recipeExists) {
      throw new Error(`Recipe already exists: ${recipePath}`);
    }
  }

  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf8");
  }

  if (recipe && recipePath) {
    await fs.mkdir(path.dirname(recipePath), { recursive: true });
    await fs.writeFile(recipePath, recipe.content, "utf8");
  }

  return { dir, scopedName, files: Object.keys(files).sort(), recipePath };
}

/**
 * Find the project root for `--project`: walk up from `startDir` and return the
 * nearest ancestor that looks like a project.
 * A `.daintree/` directory is the strongest signal; `.git` is accepted at the
 * same level too, because Daintree creates `.daintree/` lazily and a repo that
 * has never had a project plugin will not have one yet. `.git` is matched as a
 * path, not a directory: in a git worktree — the case this whole feature exists
 * for — it is a file pointing at the real git dir.
 *
 * Returns `null` rather than guessing, so `--project` fails with a clear
 * message instead of silently creating `.daintree/plugins/` in whatever
 * directory the author happened to be standing in.
 */
export async function findProjectRoot(startDir: string): Promise<string | null> {
  const isDir = async (p: string): Promise<boolean> =>
    fs
      .stat(p)
      .then((stats) => stats.isDirectory())
      .catch(() => false);
  const exists = async (p: string): Promise<boolean> =>
    fs
      .access(p)
      .then(() => true)
      .catch(() => false);

  let current = path.resolve(startDir);
  for (;;) {
    if (
      (await isDir(path.join(current, ".daintree"))) ||
      (await exists(path.join(current, ".git")))
    )
      return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function cancelled<T>(value: T | symbol): value is symbol {
  return p.isCancel(value);
}

/** Options surfaced as CLI flags on `daintree-plugin new` (see `cli.ts`). */
export interface RunNewOptions {
  /** `--publisher`: skips (or, with `--yes`, supplies) the publisher prompt. */
  publisher?: string;
  /** `--template`: skips (or supplies) the template prompt; validated against `TEMPLATE_KINDS`. */
  template?: string;
  /** `--yes`: fully non-interactive — accept defaults, never prompt (CI/scripting). */
  yes?: boolean;
  /**
   * `--project`: scaffold into the enclosing project's `.daintree/plugins/`
   * instead of a directory under the cwd. A flag rather than the spec's
   * `--project <name>`, because `new` already takes the name positionally and
   * the two would only ever disagree.
   */
  project?: boolean;
}

/**
 * Resolve the project root for `--project`, or throw with the reason. Kept
 * separate from the scaffold so both the interactive and `--yes` paths fail the
 * same way.
 */
async function resolveProjectRootOrThrow(): Promise<string> {
  const root = await findProjectRoot(process.cwd());
  if (!root) {
    throw new Error(
      `--project needs a project to scaffold into, but no .daintree/ or .git directory was found ` +
        `at or above ${process.cwd()}. Run this from inside the project, or drop --project to ` +
        `create a standalone plugin here.`
    );
  }
  return root;
}

/** "issue-helper" → "Issue Helper", the non-interactive display-name default. */
function titleCaseSegment(segment: string): string {
  return segment
    .split("-")
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function parseTemplate(value: string): TemplateKind {
  if (!(TEMPLATE_KINDS as readonly string[]).includes(value)) {
    throw new Error(`Unknown template "${value}" — expected one of: ${TEMPLATE_KINDS.join(", ")}`);
  }
  return value as TemplateKind;
}

/**
 * Templates a project-local plugin cannot use.
 *
 * The project-origin manifest schema rejects `contributes.mcpServers` — an MCP
 * server is reachable through the app-global plugin-MCP surface, where an
 * external agent session carries no project binding, so it cannot be scoped to
 * one project. Scaffolding one under `--project` would write a manifest the
 * host refuses to load, and the author would only find out on the next open.
 */
const PROJECT_INCOMPATIBLE_TEMPLATES: readonly TemplateKind[] = ["mcp", "full"];

function assertTemplateAllowedForProject(template: TemplateKind, projectLocal: boolean): void {
  if (!projectLocal || !PROJECT_INCOMPATIBLE_TEMPLATES.includes(template)) return;
  throw new Error(
    `The "${template}" template contributes an MCP server, which a project-local plugin may not declare — ` +
      `the host rejects the manifest at load. Use --template command or --template view with --project.`
  );
}

/**
 * Non-interactive `daintree-plugin new` (the `--yes` path). Scaffolds straight
 * from flags with no prompts, for CI and scripting. The plugin name and
 * `--publisher` are required (there is no prompt to fall back on); the display
 * name defaults to the title-cased plugin name and the template to `command`.
 */
async function runNewNonInteractive(name: string | undefined, opts: RunNewOptions): Promise<void> {
  if (!name) {
    throw new Error(
      "--yes requires a plugin name argument, e.g. `daintree-plugin new issue-helper --yes --publisher acme`"
    );
  }
  if (!opts.publisher) {
    throw new Error("--yes requires --publisher (there is no interactive prompt to fall back on)");
  }
  const template = opts.template ? parseTemplate(opts.template) : "command";
  assertTemplateAllowedForProject(template, opts.project === true);
  const projectRoot = opts.project ? await resolveProjectRootOrThrow() : undefined;

  // scaffoldPlugin validates the name/publisher segment grammar and throws a
  // clear message, so no pre-check is needed here.
  const result = await scaffoldPlugin({
    cwd: process.cwd(),
    targetDir: name,
    publisher: opts.publisher,
    displayName: titleCaseSegment(name),
    template,
    projectRoot,
  });

  console.log(`Created ${result.scopedName} in ${path.relative(process.cwd(), result.dir) || "."}`);
  if (result.recipePath) {
    console.log(`Watcher recipe: ${path.relative(process.cwd(), result.recipePath)}`);
  }
}

/**
 * `daintree-plugin new`. With `--yes`, runs fully non-interactively from flags
 * (see `runNewNonInteractive`). Otherwise prompts for publisher, display name,
 * and template — but `--publisher`/`--template` pre-fill their answers and skip
 * the matching prompt. The directory name is the positional `name` arg
 * (prompted for when omitted).
 */
export async function runNew(name?: string, opts: RunNewOptions = {}): Promise<void> {
  if (opts.yes) {
    await runNewNonInteractive(name, opts);
    return;
  }

  p.intro("Create a Daintree plugin");

  let targetDir = name;
  if (!targetDir) {
    const answer = await p.text({
      message: "Plugin name (also the directory)",
      placeholder: "issue-helper",
      validate: (value) => segmentError(value, "Plugin name") ?? undefined,
    });
    if (cancelled(answer)) {
      p.cancel("Cancelled");
      return;
    }
    targetDir = answer;
  } else {
    const err = segmentError(targetDir, "Plugin name");
    if (err) {
      p.cancel(err);
      return;
    }
  }

  let publisher = opts.publisher;
  if (publisher) {
    const err = segmentError(publisher, "Publisher");
    if (err) {
      p.cancel(err);
      return;
    }
  } else {
    const answer = await p.text({
      message: "Publisher",
      placeholder: "acme",
      validate: (value) => segmentError(value, "Publisher") ?? undefined,
    });
    if (cancelled(answer)) {
      p.cancel("Cancelled");
      return;
    }
    publisher = answer;
  }

  const displayName = await p.text({
    message: "Display name",
    placeholder: "Issue Helper",
    defaultValue: targetDir,
  });
  if (cancelled(displayName)) {
    p.cancel("Cancelled");
    return;
  }

  let template: TemplateKind;
  if (opts.template) {
    try {
      template = parseTemplate(opts.template);
    } catch (err) {
      p.cancel((err as Error).message);
      return;
    }
  } else {
    const answer = await p.select({
      message: "Template",
      options: TEMPLATE_KINDS.map((kind) => ({
        value: kind,
        label: kind,
        hint: TEMPLATE_HINTS[kind],
      })),
    });
    if (cancelled(answer)) {
      p.cancel("Cancelled");
      return;
    }
    template = answer as TemplateKind;
  }

  let projectRoot: string | undefined;
  if (opts.project) {
    try {
      assertTemplateAllowedForProject(template, true);
      projectRoot = await resolveProjectRootOrThrow();
    } catch (err) {
      p.cancel((err as Error).message);
      return;
    }
  }

  const result = await scaffoldPlugin({
    cwd: process.cwd(),
    targetDir,
    publisher,
    displayName: displayName || targetDir,
    template,
    projectRoot,
  });

  const relDir = path.relative(process.cwd(), result.dir) || ".";
  if (result.recipePath) {
    p.outro(
      `Created ${result.scopedName} in ${relDir}\n` +
        `Watcher recipe: ${path.relative(process.cwd(), result.recipePath)}\n` +
        `Next: cd ${relDir} && npm install && npm run dev\n` +
        `Commit dist/ — Daintree loads this plugin from the committed build, never from src/.`
    );
    return;
  }
  p.outro(
    `Created ${result.scopedName} in ${relDir}\n` +
      `Next: cd ${targetDir} && npm install && npx daintree-plugin package\n` +
      `(The @daintreehq/plugin-sdk dev dependency must be available for npm install to succeed.)`
  );
}

const TEMPLATE_HINTS: Record<TemplateKind, string> = {
  command: "single command with a handler",
  view: "panel view + React component",
  mcp: "skeleton MCP server",
  full: "command + view + MCP example",
};
