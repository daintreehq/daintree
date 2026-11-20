import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, it, expect, vi } from "vitest";
import { runPluginTypecheck } from "./build-main.mjs";
import {
  DEADLINE_STATUS,
  PROJECTS,
  parseNameStatus,
  readProcBytes,
  readRunOptions,
  runAllReason,
  resolveCompiler,
  runOnly,
  runProjectSync,
  runProjects,
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

describe("readRunOptions", () => {
  it("keeps the local defaults when nothing is set", () => {
    const defaults = { concurrency: 3, deadlineMs: 0, minAvailableBytes: 0, heartbeatMs: 0 };
    expect(readRunOptions({})).toEqual(defaults);
    expect(
      readRunOptions({
        TYPECHECK_CONCURRENCY: "",
        TYPECHECK_TIMEOUT_MINUTES: "",
        TYPECHECK_MIN_AVAILABLE_MB: "",
      })
    ).toEqual(defaults);
  });

  it("reads CI's limits and turns the heartbeat on under CI", () => {
    expect(
      readRunOptions({
        CI: "true",
        TYPECHECK_CONCURRENCY: "1",
        TYPECHECK_TIMEOUT_MINUTES: "6",
        TYPECHECK_MIN_AVAILABLE_MB: "1024",
      })
    ).toEqual({
      concurrency: 1,
      deadlineMs: 360_000,
      minAvailableBytes: 2 ** 30,
      heartbeatMs: 30_000,
    });
    expect(readRunOptions({ TYPECHECK_TIMEOUT_MINUTES: "1.5" }).deadlineMs).toBe(90_000);
    expect(readRunOptions({ CI: "false" }).heartbeatMs).toBe(0);
  });

  it("rejects a malformed value instead of dropping the limit", () => {
    for (const [name, value] of [
      ["TYPECHECK_CONCURRENCY", "0"],
      ["TYPECHECK_CONCURRENCY", "1.5"],
      ["TYPECHECK_CONCURRENCY", "two"],
      ["TYPECHECK_TIMEOUT_MINUTES", "-1"],
      ["TYPECHECK_TIMEOUT_MINUTES", "6m"],
      ["TYPECHECK_TIMEOUT_MINUTES", "Infinity"],
      ["TYPECHECK_MIN_AVAILABLE_MB", "0"],
      ["TYPECHECK_MIN_AVAILABLE_MB", "Infinity"],
    ]) {
      expect(() => readRunOptions({ [name]: value }), `${name}=${value}`).toThrow(name);
    }
  });

  it("rejects a deadline past setTimeout's range, which would fire at once", () => {
    expect(readRunOptions({ TYPECHECK_TIMEOUT_MINUTES: "35791" }).deadlineMs).toBe(2_147_460_000);
    expect(() => readRunOptions({ TYPECHECK_TIMEOUT_MINUTES: "36000" })).toThrow("at most 35791");
  });
});

describe("readProcBytes", () => {
  it("reads a /proc field in KiB as bytes, and null when it is missing", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typecheck-proc-"));
    try {
      const file = path.join(dir, "meminfo");
      writeFileSync(file, "MemTotal:       16384000 kB\nMemAvailable:    1048576 kB\n");
      expect(readProcBytes(file, "MemAvailable")).toBe(2 ** 30);
      expect(readProcBytes(file, "VmRSS")).toBeNull();
      expect(readProcBytes(path.join(dir, "missing"), "MemAvailable")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveCompiler", () => {
  it("finds the installed native TS7 compiler", async () => {
    const compiler = await resolveCompiler();
    expect(existsSync(compiler), compiler).toBe(true);
    const result = spawnSync(compiler, ["--version"], { encoding: "utf8", timeout: 30_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Version 7\./);
  });
});

describe("runProjects", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const fakeChild = (pid) => {
    const stream = () => Object.assign(new EventEmitter(), { destroy: vi.fn() });
    return Object.assign(new EventEmitter(), {
      pid,
      stdout: stream(),
      stderr: stream(),
      unref: vi.fn(),
    });
  };

  // Every spawn returns a fresh fake child; `children[i]` is the i-th spawned.
  const harness = (options = {}, deps = {}) => {
    const children = [];
    const output = [];
    const signals = new EventEmitter();
    const spawnStep = vi.fn(() => {
      const child = fakeChild(101 + children.length);
      children.push(child);
      return child;
    });
    const kill = vi.fn();
    const write = (text) => output.push(text);
    return {
      children,
      spawnStep,
      kill,
      signals,
      text: () => output.join(""),
      run: (projects) =>
        runProjects(projects, options, {
          spawnStep,
          kill,
          write,
          signals,
          rssOf: () => null,
          availableMemory: () => null,
          ...deps,
        }),
    };
  };

  const project = (name, steps = [["--noEmit", "-p", `${name}.json`]]) => ({ name, steps });
  const pending = async (promise) => {
    const marker = Symbol("pending");
    return (await Promise.race([promise, Promise.resolve(marker)])) === marker;
  };

  it("runs at most `concurrency` projects at once and prints each one's output as one block", async () => {
    const h = harness({ concurrency: 2 }, { now: () => 0 });
    const result = h.run([
      project("a", [
        ["-b", "a.json"],
        ["--noEmit", "-p", "a.preload.json"],
      ]),
      project("b"),
      project("c"),
    ]);
    expect(h.spawnStep.mock.calls.map(([args]) => args)).toEqual([
      ["-b", "a.json"],
      ["--noEmit", "-p", "b.json"],
    ]);

    h.children[0].stdout.emit("data", "a one\n");
    h.children[1].stdout.emit("data", "b one\n");
    h.children[0].stderr.emit("data", "a two\n");
    h.children[1].stderr.emit("data", Buffer.from("b two"));
    h.children[1].emit("close", 0, null);
    expect(h.spawnStep).toHaveBeenCalledTimes(3);
    expect(h.spawnStep.mock.calls[2][0]).toEqual(["--noEmit", "-p", "c.json"]);

    // A compiler can exit with its last lines still in the pipe; the next step
    // waits for `close`.
    h.children[0].emit("exit", 0, null);
    h.children[0].stdout.emit("data", "a late\n");
    expect(h.spawnStep).toHaveBeenCalledTimes(3);
    h.children[0].emit("close", 0, null);
    expect(h.spawnStep.mock.calls[3][0]).toEqual(["--noEmit", "-p", "a.preload.json"]);

    h.children[3].stdout.emit("data", "a preload\r\n");
    h.children[3].emit("close", 0, null);
    h.children[2].emit("close", 0, null);
    await expect(result).resolves.toBe(0);
    expect(h.text()).toBe(
      [
        "[b] b one",
        "[b] b two",
        "[typecheck] b passed in 0s",
        "[a] a one",
        "[a] a two",
        "[a] a late",
        "[a] a preload",
        "[typecheck] a passed in 0s",
        "[typecheck] c passed in 0s",
        "",
      ].join("\n")
    );
  });

  it("skips a failed project's later steps, finishes the others, and fails the run", async () => {
    const h = harness({ concurrency: 1 });
    const result = h.run([
      project("a", [
        ["-b", "a.json"],
        ["-p", "a2.json"],
      ]),
      project("b"),
    ]);
    h.children[0].stdout.emit("data", "a.ts(1,1): error TS2322\n");
    h.children[0].emit("close", 2, null);
    expect(h.spawnStep.mock.calls[1][0]).toEqual(["--noEmit", "-p", "b.json"]);
    h.children[1].emit("close", 0, null);
    await expect(result).resolves.toBe(1);
    expect(h.spawnStep).toHaveBeenCalledTimes(2);
    expect(h.text()).toContain("[a] a.ts(1,1): error TS2322\n[typecheck] a failed (exit 2)");
    expect(h.text()).toContain("[typecheck] b passed");
  });

  it("fails the run when only a later step fails", async () => {
    const h = harness({ concurrency: 1 });
    const result = h.run([
      project("a", [
        ["-b", "a.json"],
        ["-p", "a2.json"],
      ]),
      project("b"),
    ]);
    h.children[0].emit("close", 0, null);
    h.children[1].stdout.emit("data", "preload.cts(2,2): error TS2304\n");
    h.children[1].emit("close", 1, null);
    h.children[2].emit("close", 0, null);
    await expect(result).resolves.toBe(1);
    expect(h.text()).toContain("[a] preload.cts(2,2): error TS2304\n[typecheck] a failed (exit 1)");
  });

  it("fails a project whose compiler was killed or could not be spawned", async () => {
    let calls = 0;
    const h = harness(
      { concurrency: 1 },
      {
        spawnStep: () => {
          calls += 1;
          if (calls === 1) throw new Error("EAGAIN");
          const child = fakeChild(200);
          queueMicrotask(() => child.emit("close", null, "SIGKILL"));
          return child;
        },
      }
    );
    await expect(h.run([project("a"), project("b")])).resolves.toBe(1);
    expect(h.text()).toContain("[a] spawn failed: EAGAIN\n[typecheck] a failed (exit 1)");
    expect(h.text()).toContain("[typecheck] b failed (exit 1)");
  });

  it("fails a project once when its spawn errors, whatever follows the error", async () => {
    const h = harness({ concurrency: 1 });
    const result = h.run([project("a"), project("b")]);
    const [orphan] = h.children;
    orphan.pid = undefined;
    orphan.emit("error", new Error("ENOENT"));
    orphan.emit("close", -2, null);
    expect(h.spawnStep).toHaveBeenCalledTimes(2);
    h.children[1].emit("close", 0, null);
    h.children[1].emit("error", new Error("late"));
    await expect(result).resolves.toBe(1);
    expect(h.text()).toContain("[a] spawn failed: ENOENT\n[typecheck] a failed (exit 1)");
    expect(h.text().match(/\[typecheck\] a failed/g)).toHaveLength(1);
    expect(h.text()).not.toContain("late");
  });

  it("stops at the deadline, naming every unfinished project and killing its compiler", async () => {
    vi.useFakeTimers();
    const h = harness(
      { concurrency: 2, deadlineMs: 6 * 60_000 },
      { rssOf: (pid) => (pid === 102 ? 7 * 2 ** 30 : null), availableMemory: () => 2 ** 30 }
    );
    const result = h.run([
      project("a"),
      project("b", [
        ["-b", "b.json"],
        ["-p", "b2.json"],
      ]),
      project("c"),
      project("d"),
    ]);
    h.children[1].stdout.emit("data", "partial output");
    vi.advanceTimersByTime(5 * 60_000);
    h.children[0].emit("close", 0, null);
    expect(h.spawnStep).toHaveBeenCalledTimes(3);

    // c started at 5m00s and gets no fresh budget: the deadline is the run's.
    vi.advanceTimersByTime(60_000);
    expect(h.kill.mock.calls.map(([child]) => child.pid)).toEqual([102, 103]);
    const report = h.text().slice(h.text().indexOf("[typecheck] deadline"));
    expect(report).toBe(
      [
        "[typecheck] deadline of 6m00s reached after 6m00s: 1/4 project(s) finished, 2 still running, not started: d; 1.0 GiB available",
        "[typecheck] unfinished: b step 1/2 (pid 102, 6m00s, rss 7.0 GiB), this step 6m00s: tsc -b b.json",
        "[b] partial output",
        "[typecheck] unfinished: c step 1/1 (pid 103, 1m00s), this step 1m00s: tsc --noEmit -p c.json",
        "[c] (no compiler output yet)",
        "",
      ].join("\n")
    );

    // A diagnostic still in b's pipe is printed once, and b's next step never starts.
    h.children[1].stdout.emit("data", "b.ts(9,9): error TS2345\n");
    h.children[1].emit("close", 0, null);
    expect(await pending(result)).toBe(true);
    h.children[2].emit("close", null, "SIGKILL");
    await expect(result).resolves.toBe(124);
    expect(DEADLINE_STATUS).toBe(124);
    expect(h.spawnStep).toHaveBeenCalledTimes(3);
    expect(h.text().slice(h.text().indexOf("[typecheck] deadline") + report.length)).toBe(
      "[b] b.ts(9,9): error TS2345\n"
    );
    expect(h.text()).not.toContain("failed");
    expect(vi.getTimerCount()).toBe(0);
    expect(h.signals.eventNames()).toEqual([]);
  });

  it("gives up on a killed compiler that never closes its pipes", async () => {
    vi.useFakeTimers();
    const h = harness({ deadlineMs: 1000 });
    const result = h.run([project("a")]);
    vi.advanceTimersByTime(1000);
    expect(h.kill).toHaveBeenCalledTimes(1);
    h.children[0].stdout.emit("data", "late line\n");
    vi.advanceTimersByTime(4999);
    expect(await pending(result)).toBe(true);
    vi.advanceTimersByTime(1);
    await expect(result).resolves.toBe(DEADLINE_STATUS);
    const [child] = h.children;
    expect(h.text()).toContain(
      "[a] late line\n[typecheck] pid 101 did not exit after it was killed\n"
    );
    expect(child.stdout.destroy).toHaveBeenCalledTimes(1);
    expect(child.stderr.destroy).toHaveBeenCalledTimes(1);
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps killing after one kill throws, and clears the grace timer once the rest close", async () => {
    vi.useFakeTimers();
    const h = harness({ concurrency: 2, deadlineMs: 1000 });
    h.kill.mockImplementationOnce(() => {
      throw new Error("EPERM");
    });
    h.kill.mockImplementation((child) => child.emit("close", null, "SIGKILL"));
    const result = h.run([project("a"), project("b")]);
    vi.advanceTimersByTime(1000);
    expect(h.kill).toHaveBeenCalledTimes(2);
    expect(h.text()).toContain("[typecheck] could not kill pid 101: EPERM\n");
    h.children[0].emit("close", null, "SIGKILL");
    await expect(result).resolves.toBe(DEADLINE_STATUS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("prints a heartbeat with each running project's step, pid, age and memory", async () => {
    vi.useFakeTimers();
    const h = harness(
      { concurrency: 1, heartbeatMs: 30_000, deadlineMs: 6 * 60_000 },
      { rssOf: () => 2 * 2 ** 30, availableMemory: () => 8 * 2 ** 30 }
    );
    const result = h.run([
      project("a", [
        ["-b", "a.json"],
        ["-p", "a2.json"],
      ]),
      project("b"),
    ]);
    expect(h.text()).toBe(
      "[typecheck] 2 project(s), 1 at a time, deadline 6m00s; 8.0 GiB available\n"
    );
    vi.advanceTimersByTime(20_000);
    h.children[0].emit("close", 0, null);
    vi.advanceTimersByTime(10_000);
    expect(h.text()).toContain(
      "[typecheck] 30s: 0/2 finished, running a step 2/2 (pid 102, 30s, rss 2.0 GiB); 1 queued; 8.0 GiB available\n"
    );
    h.children[1].emit("close", 0, null);
    vi.advanceTimersByTime(30_000);
    expect(h.text()).toContain(
      "[typecheck] 1m00s: 1/2 finished, running b step 1/1 (pid 103, 30s, rss 2.0 GiB); 0 queued; 8.0 GiB available\n"
    );
    h.children[2].emit("close", 0, null);
    await expect(result).resolves.toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops when available memory falls under the floor, ignoring unreadable samples", async () => {
    vi.useFakeTimers();
    const samples = [4 * 2 ** 30, 4 * 2 ** 30, null, 2 ** 30, 2 ** 29];
    const h = harness(
      { minAvailableBytes: 2 ** 30 },
      { availableMemory: () => (samples.length > 1 ? samples.shift() : samples[0]) }
    );
    const result = h.run([project("a")]);
    vi.advanceTimersByTime(4000);
    expect(h.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(h.text()).toContain(
      "[typecheck] available memory is 0.5 GiB, under the 1.0 GiB floor after 6s: 0/1 project(s) finished, 1 still running; 0.5 GiB available\n"
    );
    expect(h.kill).toHaveBeenCalledTimes(1);
    h.children[0].emit("close", null, "SIGKILL");
    await expect(result).resolves.toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts no compiler when memory is already under the floor", async () => {
    vi.useFakeTimers();
    const h = harness({ minAvailableBytes: 2 ** 30 }, { availableMemory: () => 2 ** 29 });
    await expect(h.run([project("a"), project("b")])).resolves.toBe(1);
    expect(h.spawnStep).not.toHaveBeenCalled();
    expect(h.text()).toContain("not started: a, b");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips the memory floor where MemAvailable cannot be read", async () => {
    vi.useFakeTimers();
    const h = harness({ minAvailableBytes: 2 ** 30 });
    const result = h.run([project("a")]);
    expect(vi.getTimerCount()).toBe(0);
    h.children[0].emit("close", 0, null);
    await expect(result).resolves.toBe(0);
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ])("stops on %s, kills the running compilers and removes its handlers", async (signal, code) => {
    const h = harness({ concurrency: 2 }, { now: () => 0 });
    const result = h.run([project("a"), project("b"), project("c")]);
    expect(h.signals.listenerCount(signal)).toBe(1);
    h.signals.emit(signal, signal);
    expect(h.kill).toHaveBeenCalledTimes(2);
    expect(h.text()).toContain(
      `[typecheck] received ${signal} after 0s: 0/3 project(s) finished, 2 still running, not started: c`
    );
    h.children[0].emit("close", null, "SIGKILL");
    h.children[1].emit("close", null, "SIGKILL");
    await expect(result).resolves.toBe(code);
    expect(h.spawnStep).toHaveBeenCalledTimes(2);
    expect(h.signals.eventNames()).toEqual([]);
  });

  it("clears the grace timer when every kill closes its compiler at once", async () => {
    vi.useFakeTimers();
    const h = harness({ concurrency: 2, deadlineMs: 1000 });
    h.kill.mockImplementation((child) => child.emit("close", null, "SIGKILL"));
    const result = h.run([project("a"), project("b")]);
    vi.advanceTimersByTime(1000);
    await expect(result).resolves.toBe(DEADLINE_STATUS);
    expect(h.kill).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exits at once only on a second signal, not on the first after a deadline stop", async () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {});
    try {
      const h = harness({ deadlineMs: 1000 });
      const result = h.run([project("a")]);
      vi.advanceTimersByTime(1000);
      h.signals.emit("SIGTERM", "SIGTERM");
      expect(exit).not.toHaveBeenCalled();
      h.signals.emit("SIGINT", "SIGINT");
      expect(exit).toHaveBeenCalledWith(130);
      h.children[0].emit("close", null, "SIGKILL");
      await expect(result).resolves.toBe(DEADLINE_STATUS);
    } finally {
      exit.mockRestore();
    }
  });

  it("treats a compiler that Ctrl+C reached first as an interruption, not a failure", async () => {
    const h = harness({ concurrency: 1 }, { now: () => 0 });
    const result = h.run([project("a"), project("b")]);
    h.children[0].emit("close", null, "SIGINT");
    h.signals.emit("SIGINT", "SIGINT");
    await expect(result).resolves.toBe(130);
    expect(h.spawnStep).toHaveBeenCalledTimes(1);
    expect(h.text()).toContain("[typecheck] compiler interrupted by SIGINT after 0s");
    expect(h.text()).not.toContain("failed");
  });

  it("leaves no timers or signal handlers behind after a clean run", async () => {
    vi.useFakeTimers();
    const h = harness(
      { heartbeatMs: 30_000, deadlineMs: 60_000, minAvailableBytes: 2 ** 30 },
      { availableMemory: () => 2 ** 33 }
    );
    const result = h.run([project("a")]);
    expect(vi.getTimerCount()).toBe(3);
    h.children[0].emit("close", 0, null);
    await expect(result).resolves.toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.signals.eventNames()).toEqual([]);
  });

  it("kills a real compiler that ignores SIGTERM when the run stops", async () => {
    const signals = new EventEmitter();
    const output = [];
    let child;
    let ready;
    const isReady = new Promise((resolve) => (ready = resolve));
    const spawnStep = () => {
      child = spawn(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM', () => {}); process.stdout.write('checking'); setInterval(() => {}, 1000)",
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      child.stdout.once("data", () => ready());
      return child;
    };
    try {
      const result = runProjects(
        [project("hung")],
        {},
        { spawnStep, write: (text) => output.push(text), signals }
      );
      await isReady;
      const closed = new Promise((resolve) => child.once("close", (_, signal) => resolve(signal)));
      signals.emit("SIGTERM", "SIGTERM");
      const signal = await closed;
      // On Windows the kill is TerminateProcess, whatever signal name it reports.
      if (process.platform !== "win32") expect(signal).toBe("SIGKILL");
      await expect(result).resolves.toBe(143);
      expect(output.join("")).toContain(`(pid ${child.pid}`);
      expect(output.join("")).toContain("[hung] checking");
      if (process.platform === "linux") expect(output.join("")).toMatch(/\d\.\d GiB available/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
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
