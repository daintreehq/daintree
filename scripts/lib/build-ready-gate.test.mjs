import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { context } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createBuildReadyGate, startWatchBuild } from "./build-ready-gate.mjs";

function fakeBuild(gate, name) {
  let start;
  let end;
  gate.plugin(name).setup({ onStart: (cb) => (start = cb), onEnd: (cb) => (end = cb) });
  return {
    start: () => start(),
    ok: () => end({ errors: [] }),
    fail: () => end({ errors: [{ text: "boom" }] }),
  };
}

describe("createBuildReadyGate", () => {
  let write;
  let onFirstReady;

  beforeEach(() => {
    vi.useFakeTimers();
    write = vi.fn();
    onFirstReady = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(names = ["main", "preload"]) {
    const gate = createBuildReadyGate({ names, write, onFirstReady, delayMs: 100 });
    const builds = Object.fromEntries(names.map((name) => [name, fakeBuild(gate, name)]));
    return { gate, builds };
  }

  it("stays shut when a fast preload finishes while main is still building", () => {
    const { gate, builds } = setup();
    gate.markAssetsReady();
    builds.main.start();
    builds.preload.start();
    builds.preload.ok();
    vi.advanceTimersByTime(1000);
    expect(write).not.toHaveBeenCalled();

    builds.main.ok();
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(1);
    expect(onFirstReady).toHaveBeenCalledTimes(1);
  });

  it("stays shut on an initial compile error and opens once it is repaired", () => {
    const { gate, builds } = setup();
    gate.markAssetsReady();
    builds.preload.ok();
    builds.main.fail();
    vi.advanceTimersByTime(1000);
    expect(write).not.toHaveBeenCalled();

    builds.main.start();
    builds.main.ok();
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("waits for the copied assets even when every build is green", () => {
    const { gate, builds } = setup();
    builds.main.ok();
    builds.preload.ok();
    vi.advanceTimersByTime(1000);
    expect(write).not.toHaveBeenCalled();

    gate.markAssetsReady();
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("does not write when a build restarts inside the debounce", () => {
    const { gate, builds } = setup();
    gate.markAssetsReady();
    builds.preload.ok();
    builds.main.ok();
    vi.advanceTimersByTime(50);
    builds.main.start();
    vi.advanceTimersByTime(1000);
    expect(write).not.toHaveBeenCalled();
  });

  it("rewrites the marker after each later green rebuild, once per burst", () => {
    const { gate, builds } = setup();
    gate.markAssetsReady();
    builds.main.ok();
    builds.preload.ok();
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(1);

    // One shared edit rebuilds both contexts a few milliseconds apart.
    builds.main.start();
    builds.main.ok();
    vi.advanceTimersByTime(30);
    builds.preload.start();
    builds.preload.ok();
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(2);
    expect(onFirstReady).toHaveBeenCalledTimes(1);
  });

  it("holds incremental rewrites while another build is broken", () => {
    const { gate, builds } = setup();
    gate.markAssetsReady();
    builds.main.ok();
    builds.preload.ok();
    vi.advanceTimersByTime(100);

    builds.main.start();
    builds.main.fail();
    builds.preload.start();
    builds.preload.ok();
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenCalledTimes(1);

    builds.main.start();
    builds.main.ok();
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("never writes after dispose", () => {
    const { gate, builds } = setup();
    gate.markAssetsReady();
    builds.main.ok();
    builds.preload.ok();
    gate.dispose();
    vi.advanceTimersByTime(1000);
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses a build it was not told to wait for", () => {
    const { gate } = setup();
    expect(() => gate.plugin("sdk")).toThrow(/Unknown build "sdk"/);
  });
});

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("startWatchBuild with real esbuild contexts", () => {
  let workDir;
  let readyFile;
  let watch;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "build-ready-gate-"));
    readyFile = path.join(workDir, "out/.build-ready.js");
    fs.writeFileSync(path.join(workDir, "main.js"), 'export const main = "new main";\n');
    fs.writeFileSync(path.join(workDir, "preload.js"), 'export const preload = "new preload";\n');
  });

  afterEach(async () => {
    await watch?.dispose();
    watch = undefined;
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function config(name, plugins = []) {
    return {
      absWorkingDir: workDir,
      entryPoints: [`${name}.js`],
      outfile: `out/${name}.js`,
      bundle: true,
      format: "esm",
      logLevel: "silent",
      plugins,
    };
  }

  function holdFirstBuild() {
    let release;
    const held = new Promise((resolve) => (release = resolve));
    let first = true;
    return {
      release: () => release(),
      plugin: {
        name: "hold-first-build",
        setup(buildApi) {
          buildApi.onStart(async () => {
            if (!first) return;
            first = false;
            await held;
          });
        },
      },
    };
  }

  function endCounter() {
    const results = [];
    return {
      results,
      plugin: {
        name: "end-counter",
        setup(buildApi) {
          buildApi.onEnd((result) => {
            results.push(result.errors.length);
          });
        },
      },
    };
  }

  const read = (rel) => fs.readFileSync(path.join(workDir, rel), "utf8");

  it("keeps the old marker gone and the gate shut while a slow main build lags a fast preload", async () => {
    // A dirty checkout: last session's output and marker are still on disk.
    fs.mkdirSync(path.join(workDir, "out"), { recursive: true });
    fs.writeFileSync(path.join(workDir, "out/main.js"), "// old main\n");
    fs.writeFileSync(readyFile, "// build ready 0\n");

    const hold = holdFirstBuild();
    const preloadEnds = endCounter();
    const onFirstReady = vi.fn();
    watch = await startWatchBuild({
      configs: { main: config("main", [hold.plugin]), preload: config("preload", [preloadEnds.plugin]) },
      readyFile,
      onFirstReady,
      createContext: context,
      delayMs: 10,
    });

    expect(fs.existsSync(readyFile)).toBe(false);
    await waitFor(() => preloadEnds.results.length > 0);
    expect(read("out/preload.js")).toContain("new preload");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fs.existsSync(readyFile)).toBe(false);
    expect(read("out/main.js")).toBe("// old main\n");
    expect(onFirstReady).not.toHaveBeenCalled();

    hold.release();
    await waitFor(() => fs.existsSync(readyFile));
    expect(read("out/main.js")).toContain("new main");
    expect(onFirstReady).toHaveBeenCalledTimes(1);
  });

  it("stays shut through an initial compile error and opens after the watcher rebuilds the repair", async () => {
    fs.writeFileSync(path.join(workDir, "main.js"), "export const main = ;\n");
    const mainEnds = endCounter();
    const preloadEnds = endCounter();
    watch = await startWatchBuild({
      configs: { main: config("main", [mainEnds.plugin]), preload: config("preload", [preloadEnds.plugin]) },
      readyFile,
      createContext: context,
      delayMs: 10,
    });

    await waitFor(() => mainEnds.results.length > 0 && preloadEnds.results.length > 0);
    expect(mainEnds.results[0]).toBeGreaterThan(0);
    expect(preloadEnds.results[0]).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fs.existsSync(readyFile)).toBe(false);

    fs.writeFileSync(path.join(workDir, "main.js"), 'export const main = "repaired";\n');
    await waitFor(() => fs.existsSync(readyFile));
    expect(read("out/main.js")).toContain("repaired");
  });

  it("rewrites the marker when the watcher rebuilds after the first open", async () => {
    const preloadEnds = endCounter();
    watch = await startWatchBuild({
      configs: { main: config("main"), preload: config("preload", [preloadEnds.plugin]) },
      readyFile,
      createContext: context,
      delayMs: 10,
    });
    await waitFor(() => fs.existsSync(readyFile));
    fs.rmSync(readyFile);

    const builds = preloadEnds.results.length;
    fs.writeFileSync(path.join(workDir, "preload.js"), 'export const preload = "edited";\n');
    await waitFor(() => preloadEnds.results.length > builds && fs.existsSync(readyFile));
    expect(read("out/preload.js")).toContain("edited");
  });

  it("disposes the contexts it made when another one fails to start", async () => {
    const made = { dispose: vi.fn(async () => {}), watch: vi.fn(async () => {}) };
    const createContext = vi.fn(async (options) => {
      if (options.entryPoints[0] === "preload.js") throw new Error("bad config");
      return made;
    });
    await expect(
      startWatchBuild({
        configs: { main: config("main"), preload: config("preload") },
        readyFile,
        createContext,
      })
    ).rejects.toThrow("bad config");
    expect(made.dispose).toHaveBeenCalledTimes(1);
    expect(made.watch).not.toHaveBeenCalled();
  });
});
