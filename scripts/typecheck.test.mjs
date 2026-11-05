import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, it, expect, vi } from "vitest";
import { runPluginTypecheck } from "./build-main.mjs";
import {
  PROJECTS,
  parseNameStatus,
  runAllReason,
  runOnly,
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
  it("has unique names and at least one step and config per project", () => {
    expect(new Set(PROJECTS.map((project) => project.name)).size).toBe(PROJECTS.length);
    for (const project of PROJECTS) {
      expect(project.steps.length, project.name).toBeGreaterThan(0);
      expect(project.configs.length, project.name).toBeGreaterThan(0);
    }
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
  const electron = PROJECTS.find((project) => project.name === "electron");

  it("fails with a message naming every known project when the project does not exist", () => {
    quietly((error) => {
      const spawnStep = vi.fn();
      expect(runProjectSync("nope", { spawnStep })).toBe(1);
      expect(spawnStep).not.toHaveBeenCalled();
      const message = error.mock.calls.flat().join("\n");
      expect(message).toContain('unknown project "nope"');
      for (const project of PROJECTS) expect(message).toContain(project.name);
    });
  });

  it.each(["root", "plugins"])("runs the %s project's steps on the TS7 compiler", (name) => {
    const spawnStep = vi.fn(() => ({ status: 0 }));
    expect(runProjectSync(name, { spawnStep })).toBe(0);
    const { steps } = PROJECTS.find((project) => project.name === name);
    expect(spawnStep.mock.calls.map(([, args]) => args.slice(1))).toEqual(steps);
    for (const [command, args, options] of spawnStep.mock.calls) {
      expect(command).toBe(process.execPath);
      expect(args[0].replaceAll("\\", "/")).toBe("node_modules/typescript7/bin/tsc");
      expect(path.resolve(options.cwd)).toBe(ROOT);
      expect(options.stdio).toBe("inherit");
    }
  });

  it("runs a multi-step project's steps in order", () => {
    expect(electron.steps.length).toBeGreaterThan(1);
    const spawnStep = vi.fn(() => ({ status: 0 }));
    expect(runProjectSync("electron", { spawnStep })).toBe(0);
    expect(spawnStep.mock.calls.map(([, args]) => args.slice(1))).toEqual(electron.steps);
  });

  it("stops at the first failing step and returns its status", () => {
    const spawnStep = vi.fn().mockReturnValueOnce({ status: 2 });
    expect(runProjectSync("electron", { spawnStep })).toBe(2);
    expect(spawnStep).toHaveBeenCalledTimes(1);
  });

  it("returns a later step's failure status after earlier steps passed", () => {
    const spawnStep = vi.fn().mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 3 });
    expect(runProjectSync("electron", { spawnStep })).toBe(3);
    expect(spawnStep).toHaveBeenCalledTimes(2);
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
});

describe("runOnly", () => {
  it("runs exactly the named project and returns its status", () => {
    const runProject = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(7);
    expect(runOnly(["--only", "root"], runProject)).toBe(0);
    expect(runOnly(["--only", "plugins"], runProject)).toBe(7);
    expect(runProject.mock.calls).toEqual([["root"], ["plugins"]]);
  });

  it("passes an empty name through when none is given, so the runner rejects it", () => {
    const runProject = vi.fn(() => 1);
    expect(runOnly(["--only"], runProject)).toBe(1);
    expect(runProject).toHaveBeenCalledWith("");
  });

  it("refuses to be combined with the all-project modes", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const flag of ["--changed", "--dry-run"]) {
        const runProject = vi.fn(() => 0);
        expect(runOnly(["--only", "root", flag], runProject), flag).toBe(2);
        expect(runProject).not.toHaveBeenCalled();
      }
    } finally {
      error.mockRestore();
    }
  });
});

describe("--only CLI", () => {
  const cli = (...args) =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./typecheck.mjs", import.meta.url)), ...args],
      { encoding: "utf8", timeout: 30_000 }
    );

  it("rejects an unknown project", () => {
    const result = cli("--only", "nope");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown project "nope"');
  });

  it("rejects a missing project name", () => {
    const result = cli("--only");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown project ""');
  });

  it("rejects being combined with --changed or --dry-run", () => {
    for (const flag of ["--changed", "--dry-run"]) {
      const result = cli("--only", "root", flag);
      expect(result.status, flag).toBe(2);
      expect(result.stderr).toContain("cannot be combined");
    }
  });
});

describe("runPluginTypecheck", () => {
  const quietly = (fn) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      return fn();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  };

  it("exits with the plugins project's failing status", () => {
    quietly(() => {
      const runProject = vi.fn(() => 5);
      const exit = vi.fn();
      runPluginTypecheck({ watch: false, runProject, exit });
      expect(runProject).toHaveBeenCalledWith("plugins");
      expect(exit).toHaveBeenCalledWith(5);
    });
  });

  it("lets the build continue when the plugins project passes", () => {
    quietly(() => {
      const exit = vi.fn();
      runPluginTypecheck({ watch: false, runProject: () => 0, exit });
      expect(exit).not.toHaveBeenCalled();
    });
  });

  it("skips the typecheck in watch mode", () => {
    quietly(() => {
      const runProject = vi.fn(() => 1);
      const exit = vi.fn();
      runPluginTypecheck({ watch: true, runProject, exit });
      expect(runProject).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    });
  });
});

describe("build type gates", () => {
  const scripts = JSON.parse(readRepoFile("package.json")).scripts;
  const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1");
  const buildMain = stripComments(readRepoFile("scripts/build-main.mjs"));

  const usesTs6 = (token) => {
    const normalized = token.replace(/["']/g, "").replaceAll("\\", "/");
    return (
      /^tsc(\.cmd)?$/.test(normalized) ||
      /(^|\/)(typescript\/bin|\.bin)\/tsc(\.js|\.cmd)?$/.test(normalized)
    );
  };

  it("recognises every spelling of a TS6 invocation", () => {
    for (const token of [
      "tsc",
      "tsc.cmd",
      '"node_modules/typescript/bin/tsc"',
      "node_modules/typescript/bin/tsc.js",
      "node_modules\\typescript\\bin\\tsc",
      "node_modules/.bin/tsc",
    ]) {
      expect(usesTs6(token), token).toBe(true);
    }
    expect(usesTs6("node_modules/typescript7/bin/tsc")).toBe(false);
    expect(usesTs6("scripts/typecheck.mjs")).toBe(false);
  });

  it("never typechecks with the TS6 compiler", () => {
    const offenders = Object.entries(scripts).filter(([, command]) =>
      command.split(/[\s;&|]+/).some(usesTs6)
    );
    expect(offenders.map(([name]) => name)).toEqual([]);
    // Matches both the literal path and a path.join("typescript", "bin", ...) spelling.
    expect(buildMain).not.toMatch(/typescript["'`]?\s*[,/]\s*["'`]?bin/);
  });

  it("starts every build with the TS7 root typecheck, with no way past a failure", () => {
    for (const name of ["build:app", "build:e2e", "build:e2e:bench"]) {
      expect(scripts[name], name).toMatch(/^node scripts\/typecheck\.mjs --only root && /);
      expect(scripts[name], name).not.toMatch(/\|\||;/);
    }
  });

  it("runs the plugin gates in build-main before it cleans or emits anything", () => {
    const body = buildMain.slice(buildMain.indexOf("async function run()"));
    const order = [
      "  validatePluginManifests();",
      "  validateCommandHandlerExtensions();",
      "  runPluginTypecheck();",
      "fs.rmSync(",
      "build(esmConfig)",
    ].map((needle) => ({ needle, at: body.indexOf(needle) }));
    for (const { needle, at } of order) expect(at, needle).toBeGreaterThan(-1);
    expect(order.map(({ at }) => at)).toEqual(order.map(({ at }) => at).sort((a, b) => a - b));
  });
});
