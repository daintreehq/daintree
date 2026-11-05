import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, it, expect, vi } from "vitest";
import {
  PROJECTS,
  parseNameStatus,
  runAllReason,
  runProjectSync,
  selectProjects,
} from "./typecheck.mjs";

const readRepoFile = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const programs = {
  "a/tsconfig.json": ["src/a.ts", "shared/s.ts"],
  "b/tsconfig.json": ["packages/b/index.ts", "shared/s.ts"],
  "c/tsconfig.json": ["electron/c.ts"],
  "c/tsconfig.preload.json": ["electron/preload.cts"],
};
const projects = [
  { name: "a", steps: [], configs: ["a/tsconfig.json"] },
  { name: "b", steps: [], configs: ["b/tsconfig.json"] },
  { name: "c", steps: [], configs: ["c/tsconfig.json", "c/tsconfig.preload.json"] },
];
const list = (config) => programs[config] ?? null;
const names = (selected) => selected.map(({ project }) => project.name);
const edit = (path) => ({ path, removed: false, added: false });

describe("selectProjects", () => {
  it("selects only the projects whose program contains a changed file", () => {
    expect(names(selectProjects([edit("src/a.ts")], list, projects))).toEqual(["a"]);
    expect(names(selectProjects([edit("shared/s.ts")], list, projects))).toEqual(["a", "b"]);
  });

  it("matches a file in any of a project's configs", () => {
    const selected = selectProjects([edit("electron/preload.cts")], list, projects);
    expect(selected).toEqual([{ project: projects[2], reason: "electron/preload.cts" }]);
  });

  it("selects nothing when no program contains a changed file", () => {
    expect(selectProjects([edit("docs/README.md")], list, projects)).toEqual([]);
    expect(selectProjects([], list, projects)).toEqual([]);
  });

  it("checks a project whose program cannot be listed", () => {
    const selected = selectProjects(
      [edit("docs/README.md")],
      (config) => (config === "b/tsconfig.json" ? null : list(config)),
      projects
    );
    expect(selected).toEqual([{ project: projects[1], reason: "could not list b/tsconfig.json" }]);
  });

  it("selects everything for manifest, tsconfig and source deletions", () => {
    for (const change of [
      edit("package.json"),
      edit("packages/b/package.json"),
      edit("package-lock.json"),
      edit("tsconfig.e2e.json"),
      edit("electron/tsconfig.preload.json"),
      { path: "shared/gone.ts", removed: true },
      { path: "src/data.json", removed: true },
      { path: "src/old.js", removed: true },
      { path: "src/hooks.js", removed: false, added: true },
      edit("packages/svelte-source-model/src/types.ts"),
    ]) {
      expect(names(selectProjects([change], list, projects))).toEqual(["a", "b", "c"]);
    }
  });

  it("treats an added TypeScript file like any other edit", () => {
    expect(
      names(selectProjects([{ path: "src/a.ts", removed: false, added: true }], list, projects))
    ).toEqual(["a"]);
  });

  it("ignores deletions of files no compiler reads", () => {
    expect(runAllReason({ path: "docs/old.md", removed: true })).toBeNull();
    expect(selectProjects([{ path: "docs/old.md", removed: true }], list, projects)).toEqual([]);
  });
});

describe("parseNameStatus", () => {
  it("reads modifications, additions, deletions, renames and copies", () => {
    const output = [
      "M",
      "src/a.ts",
      "A",
      "src/new.ts",
      "D",
      "src/old.ts",
      "R087",
      "src/from.ts",
      "src/to.ts",
      "C100",
      "src/orig.ts",
      "src/copy.ts",
      "",
    ].join("\0");
    expect(parseNameStatus(output)).toEqual([
      { path: "src/a.ts", removed: false, added: false },
      { path: "src/new.ts", removed: false, added: true },
      { path: "src/old.ts", removed: true, added: false },
      { path: "src/from.ts", removed: true, added: false },
      { path: "src/to.ts", removed: false, added: true },
      { path: "src/copy.ts", removed: false, added: true },
    ]);
  });

  it("keeps paths containing spaces and tabs intact", () => {
    expect(parseNameStatus("M\0src/a b\tc.ts\0")).toEqual([
      { path: "src/a b\tc.ts", removed: false, added: false },
    ]);
  });
});

describe("PROJECTS", () => {
  it("has unique names and at least one config per project", () => {
    expect(new Set(PROJECTS.map((project) => project.name)).size).toBe(PROJECTS.length);
    for (const project of PROJECTS) expect(project.configs.length).toBeGreaterThan(0);
  });

  it("emits every tsc -b build, references included, under dist-typecheck", () => {
    // dist-electron/** is packaged wholesale, and esbuild owns dist-electron/electron,
    // so a referenced project writing there ships its per-file output in app.asar
    // (#6279, #16279).
    const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} };
    const typecheckDir = path.join(ROOT, "dist-typecheck");
    const pending = PROJECTS.flatMap((project) =>
      project.steps.filter((args) => args[0] === "-b").map((args) => path.join(ROOT, args[1]))
    );
    const seen = new Set();
    while (pending.length > 0) {
      const config = pending.pop();
      if (seen.has(config)) continue;
      seen.add(config);
      const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, host);
      const label = path.relative(ROOT, config);
      expect(parsed?.options.outDir, `${label} has no outDir`).toBeTruthy();
      // An outDir on another Windows drive comes back absolute, not as `..`.
      const outDir = path.relative(typecheckDir, parsed.options.outDir);
      const inside =
        !path.isAbsolute(outDir) && outDir !== ".." && !outDir.startsWith(`..${path.sep}`);
      expect(inside, `${label} emits to ${parsed.options.outDir}`).toBe(true);
      for (const ref of parsed.projectReferences ?? []) {
        pending.push(ts.resolveProjectReferencePath(ref));
      }
    }
    expect([...seen].map((config) => path.relative(ROOT, config))).toContain(
      path.join("shared", "tsconfig.json")
    );
  });
});

describe("runProjectSync", () => {
  const quietly = (fn) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      return fn(error);
    } finally {
      error.mockRestore();
    }
  };

  it("fails with a message naming the known projects when the project does not exist", () => {
    quietly((error) => {
      const spawnStep = vi.fn();
      expect(runProjectSync("nope", { spawnStep })).toBe(1);
      expect(spawnStep).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('unknown project "nope"'));
      expect(error).toHaveBeenCalledWith(expect.stringContaining("root, "));
    });
  });

  it("runs the project's steps in order on the TS7 compiler from the repo root", () => {
    const spawnStep = vi.fn(() => ({ status: 0 }));
    expect(runProjectSync("electron", { spawnStep })).toBe(0);
    expect(spawnStep.mock.calls.map(([, args]) => args.slice(1))).toEqual(
      PROJECTS.find((project) => project.name === "electron").steps
    );
    for (const [command, args, options] of spawnStep.mock.calls) {
      expect(command).toBe(process.execPath);
      expect(args[0].replaceAll("\\", "/")).toBe("node_modules/typescript7/bin/tsc");
      expect(options).toEqual({ cwd: expect.stringMatching(/\S/), stdio: "inherit" });
    }
  });

  it("stops at the first failing step and returns its status", () => {
    const spawnStep = vi.fn().mockReturnValueOnce({ status: 2 });
    expect(runProjectSync("electron", { spawnStep })).toBe(2);
    expect(spawnStep).toHaveBeenCalledTimes(1);
  });

  it("fails when the compiler was killed by a signal or could not be spawned", () => {
    quietly((error) => {
      expect(runProjectSync("root", { spawnStep: () => ({ status: null }) })).toBe(1);
      const failure = new Error("spawn failed");
      expect(runProjectSync("root", { spawnStep: () => ({ status: null, error: failure }) })).toBe(
        1
      );
      expect(error).toHaveBeenCalledWith(expect.stringContaining("spawn failed"), failure);
    });
  });

  it("covers the root and plugins projects the build gates on", () => {
    const names = PROJECTS.map((project) => project.name);
    expect(names).toContain("root");
    expect(names).toContain("plugins");
  });
});

describe("--only", () => {
  const cli = (...args) =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./typecheck.mjs", import.meta.url)), ...args],
      {
        encoding: "utf8",
      }
    );

  it("rejects an unknown project", () => {
    const result = cli("--only", "nope");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown project "nope"');
  });

  it("rejects a missing project name", () => {
    expect(cli("--only").status).toBe(1);
  });

  it("rejects being combined with --changed or --dry-run", () => {
    for (const flag of ["--changed", "--dry-run"]) {
      const result = cli("--only", "root", flag);
      expect(result.status, flag).toBe(2);
      expect(result.stderr).toContain("cannot be combined");
    }
  });
});

describe("build type gates", () => {
  const scripts = JSON.parse(readRepoFile("package.json")).scripts;
  const buildMain = readRepoFile("scripts/build-main.mjs");

  it("never typechecks with the TS6 compiler", () => {
    const offenders = Object.entries(scripts).filter(([, command]) =>
      command
        .split(/[\s;&|]+/)
        .some((token) => token === "tsc" || /typescript\/bin\/tsc$/.test(token))
    );
    expect(offenders.map(([name]) => name)).toEqual([]);
    // Matches both the literal path and a path.join("typescript", "bin", ...) spelling.
    expect(buildMain).not.toMatch(/typescript["'`]?\s*[,/]\s*["'`]?bin/);
  });

  it("starts every build with the TS7 root typecheck", () => {
    for (const name of ["build:app", "build:e2e", "build:e2e:bench"]) {
      expect(scripts[name], name).toMatch(/^node scripts\/typecheck\.mjs --only root && /);
    }
  });

  it("runs the plugin gates in build-main before it cleans or emits anything", () => {
    expect(buildMain).toContain('runProjectSync("plugins")');
    const manifests = buildMain.indexOf("  validatePluginManifests();");
    const handlers = buildMain.indexOf("  validateCommandHandlerExtensions();");
    const typecheck = buildMain.indexOf("  runPluginTypecheck();");
    const clean = buildMain.indexOf("fs.rmSync(abs, { recursive: true, force: true });");
    expect(manifests).toBeGreaterThan(-1);
    expect(manifests).toBeLessThan(handlers);
    expect(handlers).toBeLessThan(typecheck);
    expect(typecheck).toBeLessThan(clean);
  });
});
