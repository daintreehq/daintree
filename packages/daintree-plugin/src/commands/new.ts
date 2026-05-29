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

/**
 * Interactive `daintree-plugin new`. Prompts for publisher, display name, and
 * template, then scaffolds the project. The directory name is the positional
 * `name` arg (prompted for when omitted).
 */
export async function runNew(name?: string): Promise<void> {
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

  const publisher = await p.text({
    message: "Publisher",
    placeholder: "acme",
    validate: (value) => segmentError(value, "Publisher") ?? undefined,
  });
  if (cancelled(publisher)) {
    p.cancel("Cancelled");
    return;
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

  const template = await p.select({
    message: "Template",
    options: TEMPLATE_KINDS.map((kind) => ({
      value: kind,
      label: kind,
      hint: TEMPLATE_HINTS[kind],
    })),
  });
  if (cancelled(template)) {
    p.cancel("Cancelled");
    return;
  }

  const result = await scaffoldPlugin({
    cwd: process.cwd(),
    targetDir,
    publisher,
    displayName: displayName || targetDir,
    template: template as TemplateKind,
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
