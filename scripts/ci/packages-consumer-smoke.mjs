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

function run(cmd, args, cwd, { capture = false } = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}  (in ${cwd})`);
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    // npm resolves `npm_config_*` from the parent's environment; a workspace
    // flag inherited from an `npm run` wrapper would retarget every command.
    env: { ...process.env, npm_config_workspace: undefined, npm_config_workspaces: undefined },
  });
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
 * with only a `types` condition, or a stylesheet, has nothing to import.
 */
export function classifySubpath(subpath, entry) {
  const targets = exportTargets(entry);
  const runtime = targets.find(
    (t) => !t.conditions.includes("types") && /\.(m?js)$/.test(t.target)
  );
  return {
    subpath,
    targets: targets.map((t) => t.target),
    importable: Boolean(runtime) && !runtime.target.startsWith("./browser/"),
    typed: targets.some((t) => t.conditions.includes("types")),
  };
}

function packTarballs(destination) {
  const tarballs = new Map();
  for (const dir of PUBLISH_WORKSPACES) {
    const out = run(
      "npm",
      ["pack", `--workspace=${dir}`, "--pack-destination", destination, "--json"],
      repoRoot,
      { capture: true }
    );
    // Lifecycle scripts (the SDK's prepack logs a line in brackets) share
    // stdout with npm's JSON, so find the array where it actually starts.
    const start = out.search(/^\[\s*\{/m);
    if (start < 0) throw new Error(`npm pack --workspace=${dir} printed no JSON:\n${out}`);
    const [info] = JSON.parse(out.slice(start));
    tarballs.set(info.name, { file: path.join(destination, info.filename), version: info.version });
  }
  return tarballs;
}

function checkEntryPoints(consumer, tarballs) {
  const imports = [];
  const typeLines = [];
  for (const name of tarballs.keys()) {
    const pkgDir = path.join(consumer, "node_modules", name);
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    for (const [subpath, entry] of Object.entries(pkg.exports ?? {})) {
      const info = classifySubpath(subpath, entry);
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

  const importScript = path.join(consumer, "import-all.mjs");
  fs.writeFileSync(
    importScript,
    `for (const specifier of ${JSON.stringify(imports)}) {\n` +
      `  const mod = await import(specifier);\n` +
      `  if (Object.keys(mod).length === 0) throw new Error(specifier + " exports nothing");\n` +
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
        skipLibCheck: true,
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

function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-packages-smoke-")));
  try {
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
    console.log("packages consumer smoke ok");
  } finally {
    if (process.env.KEEP_SMOKE_DIR) console.log(`kept ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
