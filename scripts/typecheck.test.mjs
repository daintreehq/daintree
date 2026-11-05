import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, it, expect } from "vitest";
import { PROJECTS, parseNameStatus, runAllReason, selectProjects } from "./typecheck.mjs";

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
