import fs from "node:fs/promises";
import path from "node:path";
import * as p from "@clack/prompts";
import { SCOPED_PLUGIN_NAME_PATTERN } from "../../../../electron/schemas/plugin.js";
import {
  buildTemplateFiles,
  TEMPLATE_KINDS,
  type ScaffoldContext,
  type TemplateKind,
} from "../scaffold/templates.js";

/** A single publisher/plugin name segment (the half on either side of the dot). */
const SEGMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ScaffoldPluginOptions {
  /** Parent directory the plugin folder is created under. */
  cwd: string;
  /** Folder name; doubles as the plugin segment of the scoped name. */
  targetDir: string;
  publisher: string;
  displayName: string;
  template: TemplateKind;
}

export interface ScaffoldResult {
  dir: string;
  scopedName: string;
  files: string[];
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

  const dir = path.resolve(opts.cwd, opts.targetDir);
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
  };
  const files = buildTemplateFiles(ctx);

  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf8");
  }

  return { dir, scopedName, files: Object.keys(files).sort() };
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

  // scaffoldPlugin validates the name/publisher segment grammar and throws a
  // clear message, so no pre-check is needed here.
  const result = await scaffoldPlugin({
    cwd: process.cwd(),
    targetDir: name,
    publisher: opts.publisher,
    displayName: titleCaseSegment(name),
    template,
  });

  console.log(`Created ${result.scopedName} in ${path.relative(process.cwd(), result.dir) || "."}`);
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

  const result = await scaffoldPlugin({
    cwd: process.cwd(),
    targetDir,
    publisher,
    displayName: displayName || targetDir,
    template,
  });

  p.outro(
    `Created ${result.scopedName} in ${path.relative(process.cwd(), result.dir) || "."}\n` +
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
