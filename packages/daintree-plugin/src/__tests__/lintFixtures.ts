import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lintPlugin, type LintFinding } from "../lib/lint/index.js";

export const VIEW_MANIFEST = {
  name: "acme.demo",
  version: "1.0.0",
  main: "dist/index.mjs",
  engines: { daintree: ">=0.11.0" },
  contributes: {
    views: [{ id: "main", componentPath: "dist/panel.js", location: "panel" }],
  },
};

const created: string[] = [];

/** A plugin directory holding `files`, with a `plugin.json` unless `manifest` is null. */
export async function writePlugin(
  files: Record<string, string>,
  manifest: unknown = VIEW_MANIFEST
): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "daintree-lint-")));
  created.push(dir);
  if (manifest !== null) {
    await fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest), "utf8");
  }
  for (const [relative, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
    await fs.writeFile(path.join(dir, relative), contents, "utf8");
  }
  return dir;
}

export async function cleanupPlugins(): Promise<void> {
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
}

/** Findings for `ruleId` from a plugin made of `files`. */
export async function lintFor(
  ruleId: string,
  files: Record<string, string>,
  manifest?: unknown
): Promise<LintFinding[]> {
  const dir = await writePlugin(files, manifest);
  const result = await lintPlugin({ dir, styleReport: false });
  return result.findings.filter((finding) => finding.ruleId === ruleId);
}
