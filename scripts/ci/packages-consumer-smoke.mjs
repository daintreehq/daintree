#!/usr/bin/env node
/**
 * Consumer smoke test for the published plugin packages: packs the exact
 * tarballs npm would publish and uses them the way an author outside this
 * repository does. Workspace symlinks hide a whole class of defects (a missing
 * `files` entry, an export target that was never built, a peer that only
 * resolves from the monorepo root, a scaffold pinned to the previous minor), and
 * this is the only check that sees the packages from the outside.
 *
 * 1. `npm pack` every publishable workspace.
 * 2. Install the tarballs into an empty project, then import every runtime
 *    subpath in each exports map, check every other export target exists,
 *    typecheck an import of every typed subpath, and run each bin.
 * 3. Scaffold a plugin with `create-daintree-plugin`, point its toolchain
 *    devDependencies at the tarballs (failing if the scaffold's ranges don't
 *    accept the versions being released), then install, typecheck, build,
 *    validate and package it.
 * 4. Scaffold the `app` template into a bare project, prove its committed
 *    build is there and validates before anything is installed, then install
 *    the tarballs, typecheck, run its tests, and rebuild it: the released
 *    packages must reproduce the build it shipped with, byte for byte.
 *
 * Needs the registry for third-party dependencies (react, vite, zod, ...) but
 * never publishes and needs no credentials. Expects `npm run packages:build`
 * to have run. Set KEEP_SMOKE_DIR=1 to keep the temp directory for debugging.
 *
 * Usage: npm run packages:smoke (after npm run packages:build)
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const PUBLISH_WORKSPACES = [
  "packages/plugin-sdk",
  "packages/plugin-vite",
  "packages/daintree-plugin",
  "packages/create-daintree-plugin",
  "packages/tour",
];

// Everything the packages' entry points import that isn't theirs to ship:
// declared peers (optional ones included, since some subpath needs each) and the
// types the typecheck pass reads.
const CONSUMER_DEPENDENCIES = [
  "react@^19.2.0",
  "react-dom@^19.2.0",
  "zod@^4.0.0",
  "vite@^8.0.0",
  "lucide-react@^1.47.0",
  "@playwright/test@^1.63.0",
  "esbuild@^0.28.2",
  "tailwindcss@^4.3.3",
  "typescript@^6.0.0",
  "@types/react@^19.0.0",
  "@types/react-dom@^19.0.0",
  "@types/node@^22.13.0",
];

// The scaffold's devDependencies that name a package released from this repo.
const SCAFFOLD_TOOLCHAIN = ["@daintreehq/plugin-sdk", "@daintreehq/plugin-vite", "daintree-plugin"];

// Named runtime exports an author relies on. Importing every subpath only
// proves each module loads; these prove the packed JavaScript still carries
// what the declarations promise.
const EXPECTED_EXPORTS = {
  "@daintreehq/plugin-sdk": {
    PLUGIN_STYLE_ROOT_ATTRIBUTE: "string",
    PLUGIN_PROCESS_STREAM_CHANNEL: "string",
  },
  "@daintreehq/plugin-sdk/testing": { createMockHost: "function" },
  "@daintreehq/plugin-vite": { daintreePlugin: "function" },
  "@daintreehq/tour": { TourPlayer: "function" },
  "@daintreehq/tour/react": { useCue: "function" },
  "@daintreehq/tour/kit": { MockCursor: "function" },
  "@daintreehq/tour/mock-app": { MockApp: "function" },
};

// The conditions this script knows how to exercise. Anything else fails loudly
// rather than going unchecked.
const KNOWN_CONDITIONS = new Set(["types", "import", "default"]);

export function isInside(child, parent) {
  const rel = path.relative(parent, path.resolve(child));
  return rel === "" || (rel.split(path.sep)[0] !== ".." && !path.isAbsolute(rel));
}

/**
 * The environment for every child: no inherited workspace selection (it would
 * retarget each npm command) and no repository `node_modules/.bin` on PATH,
 * which `npm run` adds and which would let a scaffold script borrow a tool it
 * never declared.
 */
export function isolatedEnv(env, root = repoRoot) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^npm_config_workspaces?$/i.test(key)) continue;
    out[key] = value;
  }
  out.PATH = (env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry && !isInside(entry, root))
    .join(path.delimiter);
  return out;
}

const childEnv = isolatedEnv(process.env);

function run(cmd, args, cwd, { capture = false } = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}  (in ${cwd})`);
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    env: childEnv,
  });
}

/** The file `npm pack` writes for a package: `@scope/name` becomes `scope-name-<version>.tgz`. */
export function tarballFilename(name, version) {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

/** An exports field in its subpath-map form; `"./index.js"` and bare condition maps are shorthand for `"."`. */
export function normalizeExports(exports) {
  if (exports === undefined || exports === null) return {};
  if (
    typeof exports === "string" ||
    Array.isArray(exports) ||
    !Object.keys(exports).some((key) => key.startsWith("."))
  ) {
    return { ".": exports };
  }
  return exports;
}

/** Every string leaf of an exports entry, with the condition path that led to it. */
export function exportTargets(entry, conditions = []) {
  if (typeof entry === "string") return [{ conditions, target: entry }];
  if (entry === null || typeof entry !== "object") return [];
  return Object.entries(entry).flatMap(([key, value]) =>
    exportTargets(value, [...conditions, key])
  );
}

/**
 * How a consumer reaches one exports subpath. Node imports a JS target, except
 * one under `./browser/`, which is a bundle served to a browser page. A subpath
 * with only a `types` condition, or a stylesheet, has nothing to import. A
 * wildcard subpath or an unknown condition throws, so a new export shape can't
 * slip through unchecked.
 */
export function classifySubpath(subpath, entry) {
  if (subpath.includes("*")) {
    throw new Error(
      `exports["${subpath}"]: wildcard subpaths are not smoke-tested; list each entry`
    );
  }
  const targets = exportTargets(entry);
  const unknown = new Set(
    targets.flatMap((t) => t.conditions).filter((c) => !KNOWN_CONDITIONS.has(c))
  );
  if (unknown.size > 0) {
    throw new Error(
      `exports["${subpath}"] uses ${[...unknown].join(", ")}, which this smoke test does not exercise; teach classifySubpath to check it`
    );
  }
  const runtime = targets.find((t) => !t.conditions.includes("types") && /\.m?js$/.test(t.target));
  return {
    subpath,
    targets: targets.map((t) => t.target),
    importable: Boolean(runtime) && !runtime.target.startsWith("./browser/"),
    typed: targets.some((t) => t.conditions.includes("types") || /\.d\.[cm]?ts$/.test(t.target)),
  };
}

function packTarballs(destination) {
  const tarballs = new Map();
  for (const dir of PUBLISH_WORKSPACES) {
    // The filename comes from the manifest rather than `npm pack --json`, whose
    // stdout lifecycle scripts (the SDK's prepack among them) write into too.
    const { name, version } = JSON.parse(
      fs.readFileSync(path.join(repoRoot, dir, "package.json"), "utf8")
    );
    run("npm", ["pack", `--workspace=${dir}`, "--pack-destination", destination], repoRoot);
    const file = path.join(destination, tarballFilename(name, version));
    if (!fs.existsSync(file)) throw new Error(`npm pack --workspace=${dir} did not write ${file}`);
    tarballs.set(name, { file, version });
  }
  return tarballs;
}

function checkEntryPoints(consumer, tarballs) {
  const imports = [];
  const typeLines = [];
  for (const name of tarballs.keys()) {
    const pkgDir = path.join(consumer, "node_modules", name);
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    for (const [subpath, entry] of Object.entries(normalizeExports(pkg.exports))) {
      const info = classifySubpath(subpath, entry);
      // A null target is an explicit exclusion: nothing to ship or check.
      if (info.targets.length === 0) continue;
      for (const target of info.targets) {
        if (!fs.existsSync(path.join(pkgDir, target))) {
          throw new Error(
            `${name}: exports["${subpath}"] points at ${target}, which is not in the tarball`
          );
        }
      }
      const specifier = subpath === "." ? name : `${name}/${subpath.slice(2)}`;
      if (info.importable) imports.push(specifier);
      if (info.typed) {
        typeLines.push(
          info.importable
            ? `export type * as m${typeLines.length} from "${specifier}";`
            : `/// <reference types="${specifier}" />`
        );
      }
    }
    for (const [bin, target] of Object.entries(pkg.bin ?? {})) {
      if (!fs.existsSync(path.join(pkgDir, target))) {
        throw new Error(`${name}: bin "${bin}" points at ${target}, which is not in the tarball`);
      }
    }
  }

  for (const specifier of Object.keys(EXPECTED_EXPORTS)) {
    if (!imports.includes(specifier))
      throw new Error(`${specifier} is no longer an importable export`);
  }
  const importScript = path.join(consumer, "import-all.mjs");
  fs.writeFileSync(
    importScript,
    `const expected = ${JSON.stringify(EXPECTED_EXPORTS)};\n` +
      `for (const specifier of ${JSON.stringify(imports)}) {\n` +
      `  const mod = await import(specifier);\n` +
      `  if (Object.keys(mod).length === 0) throw new Error(specifier + " exports nothing");\n` +
      `  for (const [symbol, type] of Object.entries(expected[specifier] ?? {})) {\n` +
      `    if (typeof mod[symbol] !== type) throw new Error(specifier + ": " + symbol + " is " + typeof mod[symbol] + ", expected " + type);\n` +
      `  }\n` +
      `  console.log("import ok: " + specifier);\n` +
      `}\n`
  );
  run(process.execPath, [importScript], consumer);

  // References first: a triple-slash directive after a statement is ignored.
  typeLines.sort((a, b) => Number(b.startsWith("///")) - Number(a.startsWith("///")));
  fs.writeFileSync(path.join(consumer, "types-check.ts"), typeLines.join("\n") + "\n");
  fs.writeFileSync(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        lib: ["ES2022", "DOM"],
        jsx: "react-jsx",
        strict: true,
        // Checked, not skipped: a shipped declaration that re-exports a file
        // left out of the tarball only errors inside that declaration.
        skipLibCheck: false,
        noEmit: true,
      },
      files: ["types-check.ts"],
    })
  );
  run(path.join(consumer, "node_modules/.bin/tsc"), ["-p", "."], consumer);
}

function checkBins(consumer, tarballs) {
  const bin = (name) => path.join(consumer, "node_modules/.bin", name);
  for (const name of ["daintree-plugin", "create-daintree-plugin"]) {
    const reported = run(bin(name), ["--version"], consumer, { capture: true }).trim();
    const expected = tarballs.get(name).version;
    if (reported !== expected)
      throw new Error(`${name} --version printed ${reported}, expected ${expected}`);
  }
  // The tour authoring commands ship in the CLI, not in @daintreehq/tour.
  for (const args of [
    ["--help"],
    ["tour", "preview", "--help"],
    ["tour", "voice", "--help"],
    ["tour", "align", "--help"],
  ]) {
    run(bin("daintree-plugin"), args, consumer, { capture: true });
  }
}

function checkScaffold(root, consumer, tarballs) {
  run(
    path.join(consumer, "node_modules/.bin/create-daintree-plugin"),
    ["smoke-plugin", "--publisher", "smoke", "--template", "full", "--yes"],
    root
  );
  const project = path.join(root, "smoke-plugin");
  const pkgFile = path.join(project, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  for (const name of SCAFFOLD_TOOLCHAIN) {
    const range = pkg.devDependencies?.[name];
    const { file, version } = tarballs.get(name);
    if (!range) throw new Error(`the scaffold no longer depends on ${name}`);
    if (!semver.satisfies(version, range)) {
      throw new Error(
        `the scaffold pins ${name}@${range}, which does not accept the ${version} being released`
      );
    }
    pkg.devDependencies[name] = `file:${file}`;
  }
  // The tour engine is the documented dev dependency for typing scenes; a probe
  // scene proves its types resolve from the tarball inside a real plugin.
  pkg.devDependencies["@daintreehq/tour"] = `file:${tarballs.get("@daintreehq/tour").file}`;
  pkg.devDependencies["lucide-react"] = "^1.47.0";
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
  fs.writeFileSync(
    path.join(project, "src", "tour-probe.tsx"),
    `import type { TourPlayer } from "@daintreehq/tour";\n` +
      `import { useCue } from "@daintreehq/tour/react";\n\n` +
      `export type Player = TourPlayer;\n` +
      `export const cue: typeof useCue = useCue;\n`
  );

  run("npm", ["install", "--no-audit", "--no-fund"], project);
  run(path.join(project, "node_modules/.bin/tsc"), ["--noEmit", "-p", "."], project);
  run("npm", ["run", "build"], project);
  run("npm", ["run", "validate"], project);
  run("npm", ["run", "package"], project);
  const packaged = fs.readdirSync(project).filter((f) => f.endsWith(".dntr"));
  if (packaged.length !== 1)
    throw new Error(`expected one .dntr in ${project}, found ${packaged.join(", ") || "none"}`);
  console.log(`packaged ${packaged[0]}`);
}

/** Every file under `dir`, keyed by POSIX path relative to it. */
export function readTree(dir) {
  const files = new Map();
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const rel = path
      .relative(dir, path.join(entry.parentPath, entry.name))
      .split(path.sep)
      .join("/");
    files.set(rel, fs.readFileSync(path.join(entry.parentPath, entry.name)));
  }
  return files;
}

/** The files two trees disagree on: missing from either side, or different bytes. */
export function treeDifferences(expected, actual) {
  const names = new Set([...expected.keys(), ...actual.keys()]);
  return [...names]
    .filter((name) => {
      const a = expected.get(name);
      const b = actual.get(name);
      return a === undefined || b === undefined || !a.equals(b);
    })
    .sort();
}

function checkAppScaffold(root, consumer, tarballs) {
  // A bare git marker is all `--project` needs to find the project root.
  const project = path.join(root, "app-project");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  run(
    path.join(consumer, "node_modules/.bin/create-daintree-plugin"),
    ["orders", "--publisher", "smoke", "--yes", "--project"],
    project
  );
  const plugin = path.join(project, ".daintree", "plugins", "smoke.orders");
  const shipped = readTree(path.join(plugin, "dist"));
  if (!shipped.has("index.js")) throw new Error("the app scaffold shipped no built dist/index.js");
  // npm drops `.gitignore` from a package; the scaffold must still write it,
  // or a repository that ignores dist/ silently loses the app's build.
  const gitignore = path.join(plugin, ".gitignore");
  if (!fs.existsSync(gitignore) || !fs.readFileSync(gitignore, "utf8").includes("!dist/")) {
    throw new Error("the app scaffold wrote no .gitignore keeping dist/ tracked");
  }
  // Before any install: this is what a teammate who opens the project gets.
  run(path.join(consumer, "node_modules/.bin/daintree-plugin"), ["validate"], plugin);

  const pkgFile = path.join(plugin, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  for (const name of [...SCAFFOLD_TOOLCHAIN, "@daintreehq/tour"]) {
    const range = pkg.devDependencies?.[name];
    const { file, version } = tarballs.get(name);
    if (!range) throw new Error(`the app scaffold no longer depends on ${name}`);
    if (!semver.satisfies(version, range)) {
      throw new Error(
        `the app scaffold pins ${name}@${range}, which does not accept the ${version} being released`
      );
    }
    pkg.devDependencies[name] = `file:${file}`;
  }
  // The committed build came from this repository's locked Vite (and the
  // Rolldown it pins). A byte-for-byte rebuild is only meaningful on that same
  // toolchain, so pin it; a newer Vite the range allows may chunk differently.
  pkg.devDependencies.vite = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "node_modules/vite/package.json"), "utf8")
  ).version;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");

  run("npm", ["install", "--no-audit", "--no-fund"], plugin);
  run(path.join(plugin, "node_modules/.bin/tsc"), ["--noEmit", "-p", "."], plugin);
  run("npm", ["test"], plugin);
  run("npm", ["run", "build"], plugin);
  const differences = treeDifferences(shipped, readTree(path.join(plugin, "dist")));
  if (differences.length > 0) {
    throw new Error(
      `rebuilding the app scaffold from the released packages changed dist/: ${differences.join(", ")}. ` +
        `The reference's committed build is stale, or the packages build it differently.`
    );
  }
  console.log("app scaffold rebuilt identically from the tarballs");
}

function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-packages-smoke-")));
  try {
    // Node and TypeScript resolve packages up the directory tree, so a consumer
    // inside the checkout would quietly see the repository's node_modules.
    if (isInside(root, fs.realpathSync(repoRoot))) {
      throw new Error(`temp dir ${root} is inside the repository; point TMPDIR elsewhere`);
    }
    const tarballDir = path.join(root, "tarballs");
    fs.mkdirSync(tarballDir);
    const tarballs = packTarballs(tarballDir);

    const consumer = path.join(root, "consumer");
    fs.mkdirSync(consumer);
    fs.writeFileSync(
      path.join(consumer, "package.json"),
      JSON.stringify({ name: "consumer", private: true, type: "module" }, null, 2)
    );
    // Every tarball in one install, so create-daintree-plugin's dependency on
    // daintree-plugin resolves to the sibling tarball rather than the registry.
    run(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        ...[...tarballs.values()].map((t) => t.file),
        ...CONSUMER_DEPENDENCIES,
      ],
      consumer
    );
    checkEntryPoints(consumer, tarballs);
    checkBins(consumer, tarballs);
    checkScaffold(root, consumer, tarballs);
    checkAppScaffold(root, consumer, tarballs);
    console.log("packages consumer smoke ok");
  } finally {
    if (process.env.KEEP_SMOKE_DIR) console.log(`kept ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
