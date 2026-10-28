#!/usr/bin/env node
// Typechecks every TypeScript project in the repo with the TS7 native compiler
// (`typescript7`; the `typescript` dependency stays on TS6 for typescript-eslint).
//
//   node scripts/typecheck.mjs                 all projects (`npm run typecheck`)
//   node scripts/typecheck.mjs --changed       only projects the branch touches
//   node scripts/typecheck.mjs --changed --base <ref> --dry-run
//
// `--changed` exists for machines running many agent worktrees at once, where
// every agent checking all twelve projects stacks compiler processes into swap.
// A project is selected when its own program (`tsc --listFilesOnly`) contains a
// file changed since the merge base with origin/develop, committed or not. That
// list is exact, so an import from an unexpected folder cannot slip past it.
// What a program list cannot show selects everything: manifests, tsconfigs,
// workspace packages (consumers read their built `dist`, which git never sees),
// deleted or renamed sources whose importers may now break, and added or
// removed JavaScript, which can shadow a module resolution without ever
// entering a program (`allowJs` is off).

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSC = "node_modules/typescript7/bin/tsc";
const CONCURRENTLY = path.join(ROOT, "node_modules/concurrently/dist/bin/index.js");
const MAX_PROCESSES = 3;

// `configs` lists every tsconfig whose program the project checks, including
// referenced composite projects, since `-b` sees those only as emitted `.d.ts`.
export const PROJECTS = [
  { name: "root", steps: [["--noEmit"]], configs: ["tsconfig.json"] },
  {
    name: "electron",
    steps: [
      ["-b", "electron/tsconfig.json"],
      ["--noEmit", "-p", "electron/tsconfig.preload.json"],
    ],
    configs: ["shared/tsconfig.json", "electron/tsconfig.json", "electron/tsconfig.preload.json"],
  },
  ...[
    ["perf", "tsconfig.perf.json"],
    ["e2e", "tsconfig.e2e.json"],
    ["plugins", "tsconfig.plugins.json"],
    ["plugin-views", "tsconfig.plugin-views.json"],
    ["daintree-plugin", "packages/daintree-plugin/tsconfig.json"],
    ["create-daintree-plugin", "packages/create-daintree-plugin/tsconfig.json"],
    ["plugin-sdk", "packages/plugin-sdk/tsconfig.json"],
    ["plugin-vite", "packages/plugin-vite/tsconfig.json"],
    ["svelte-source-model", "packages/svelte-source-model/tsconfig.json"],
    ["tour", "packages/tour/tsconfig.json"],
  ].map(([name, config]) => ({ name, steps: [["--noEmit", "-p", config]], configs: [config] })),
];

const DELETION_SENSITIVE = /\.(?:[cm]?[jt]sx?|json)$/;
const RESOLUTION_ONLY = /\.(?:[cm]?jsx?)$/;

export function runAllReason(change) {
  const base = path.posix.basename(change.path);
  if (base === "package.json" || base === "package-lock.json") return `${change.path} changed`;
  if (/^tsconfig.*\.json$/.test(base)) return `${change.path} changed`;
  if (change.path.startsWith("packages/")) return `workspace package ${change.path} changed`;
  if (change.removed && DELETION_SENSITIVE.test(change.path)) {
    return `${change.path} was deleted or renamed`;
  }
  if (change.added && RESOLUTION_ONLY.test(change.path)) return `${change.path} was added`;
  return null;
}

// `listFiles(config)` returns repo-relative posix paths, or null when the
// program could not be listed (the project is then checked to be safe).
export function selectProjects(changes, listFiles, projects = PROJECTS) {
  for (const change of changes) {
    const reason = runAllReason(change);
    if (reason) return projects.map((project) => ({ project, reason }));
  }
  const present = changes.filter((change) => !change.removed).map((change) => change.path);
  if (present.length === 0) return [];

  const selected = [];
  for (const project of projects) {
    let reason = null;
    for (const config of project.configs) {
      const files = listFiles(config);
      if (files === null) {
        reason = `could not list ${config}`;
        break;
      }
      const set = new Set(files);
      const hit = present.find((file) => set.has(file));
      if (hit) {
        reason = hit;
        break;
      }
    }
    if (reason) selected.push({ project, reason });
  }
  return selected;
}

// Parses `git diff --name-status -z`: status, path, and a second path for
// renames and copies, all NUL-separated.
export function parseNameStatus(output) {
  const tokens = output.split("\0");
  const changes = [];
  for (let i = 0; i < tokens.length && tokens[i];) {
    const status = tokens[i++];
    if (status.startsWith("R")) {
      changes.push(
        { path: tokens[i++], removed: true, added: false },
        { path: tokens[i++], removed: false, added: true }
      );
    } else if (status.startsWith("C")) {
      i++;
      changes.push({ path: tokens[i++], removed: false, added: true });
    } else {
      changes.push({ path: tokens[i++], removed: status === "D", added: status === "A" });
    }
  }
  return changes;
}

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function resolveBase(explicit) {
  const candidates = explicit ? [explicit] : ["origin/develop", "develop"];
  for (const ref of candidates) {
    try {
      return git(["merge-base", "HEAD", ref]).trim();
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function changedFiles(base) {
  const tracked = parseNameStatus(git(["diff", "--name-status", "-M", "-z", base]));
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .map((file) => ({ path: file, removed: false, added: true }));
  return [...tracked, ...untracked];
}

function listProgramFiles(config) {
  let output;
  try {
    output = execFileSync(process.execPath, [TSC, "--listFilesOnly", "-p", config], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // Partial output from a failed listing could omit the changed file.
    return null;
  }
  const files = output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
    .filter((file) => !file.startsWith("..") && !file.startsWith("node_modules/"));
  return files.length > 0 ? files : null;
}

function command(project) {
  return project.steps.map((args) => `node ${TSC} ${args.join(" ")}`).join(" && ");
}

function run(projects) {
  const args = [
    CONCURRENTLY,
    "--group",
    "--max-processes",
    String(MAX_PROCESSES),
    "--names",
    projects.map((project) => project.name).join(","),
    ...projects.map(command),
  ];
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
}

function main() {
  const argv = process.argv.slice(2);
  const changedMode = argv.includes("--changed");
  const dryRun = argv.includes("--dry-run");
  const baseIndex = argv.indexOf("--base");
  const explicitBase = baseIndex === -1 ? null : argv[baseIndex + 1];

  if (!existsSync(path.join(ROOT, TSC))) {
    console.error(`[typecheck] ${TSC} is missing; run npm install`);
    process.exit(1);
  }

  if (!changedMode) {
    if (!dryRun) run(PROJECTS);
    return;
  }

  const base = resolveBase(explicitBase);
  let selected;
  if (!base) {
    console.log("[typecheck] no merge base with develop; checking every project");
    selected = PROJECTS.map((project) => ({ project, reason: "no merge base" }));
  } else {
    const changes = changedFiles(base);
    selected = selectProjects(changes, listProgramFiles);
    console.log(
      `[typecheck] ${changes.length} changed file(s) since ${base.slice(0, 10)}; ` +
        `${selected.length} of ${PROJECTS.length} project(s) affected`
    );
  }

  for (const { project, reason } of selected) console.log(`  ${project.name}: ${reason}`);
  if (selected.length === 0 || dryRun) return;
  run(selected.map(({ project }) => project));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
