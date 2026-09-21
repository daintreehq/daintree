import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cpus, release } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { Terminal } from "@xterm/xterm";
import { expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../e2e/helpers/launch";
import { createFixtureRepo } from "../../e2e/helpers/fixtures";
import { openAndOnboardProject } from "../../e2e/helpers/project";
import { getGridPanelIds } from "../../e2e/helpers/panels";
import { fakeAgentEnv } from "../../e2e/helpers/fakeAgent";
import { SEL } from "../../e2e/helpers/selectors";
import { waitForTerminalTextById, getTerminalTextById } from "../../e2e/helpers/terminal";
import { FOREGROUND_TERMINAL_CLASS } from "./config/benchmarkClasses";

interface Counters {
  cpuNs: Record<string, number>;
  cpuTimeNs: number;
  gpu: Record<string, { pid: number; ns: number }>;
  gpuTimeNs: number;
}

interface Probe {
  renders: number;
  rows: number;
  writes: number;
  characters: number;
  inputLatencies: number[];
  pendingInputs: number;
  dispose(): void;
}

interface BenchWindow {
  __daintreeDispatchAction(
    id: string,
    args: unknown,
    options: { source: "test" }
  ): Promise<unknown>;
  __daintreeGetTerminalForE2E(id: string): Terminal;
  __daintreeGetTerminalWebGLState(id: string): { active: boolean; mode: string };
  __foregroundProbes: Record<string, Probe>;
  __foregroundRefreshStacks?: Record<string, number>;
}

const { values } = parseArgs({
  options: {
    scenario: { type: "string" },
    seconds: { type: "string", default: "30" },
    rounds: { type: "string", default: "3" },
    output: { type: "string", default: ".tmp/perf-results/foreground-terminal.json" },
    trace: { type: "boolean", default: false },
  },
});
const cases = ["idle", "spinner", "redundant", "stream", "typing", "two-spinner"];
assert(
  values.scenario && cases.includes(values.scenario),
  `Choose exactly one scenario: ${cases.join(", ")}`
);
assert(
  process.platform === "darwin" && process.arch === "arm64",
  "Foreground CPU/GPU counters currently require macOS Apple Silicon"
);
const seconds = Number(values.seconds);
const rounds = Number(values.rounds);
assert(Number.isFinite(seconds) && seconds >= 5 && seconds <= 600);
assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 20);
const root = path.resolve(import.meta.dirname, "../..");
const mode = values.scenario === "two-spinner" ? "spinner" : values.scenario;
const panelCount = values.scenario === "two-spinner" ? 2 : 1;
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const buildHash = createHash("sha256");
function hashBuild(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) hashBuild(file);
    else if (entry.isFile()) buildHash.update(path.relative(root, file)).update(readFileSync(file));
  }
}
hashBuild(path.join(root, "dist"));
hashBuild(path.join(root, "dist-electron"));
const apparatusFiles = [
  "scripts/perf/foreground-terminal.ts",
  "scripts/perf/lib/foregroundAgent.cjs",
  "scripts/perf/lib/foregroundCounters.py",
  "e2e/helpers/launch.ts",
  "e2e/helpers/project.ts",
  "e2e/helpers/panels.ts",
  "e2e/helpers/terminal.ts",
  "e2e/helpers/launchTelemetry.ts",
  "e2e/helpers/fakeAgent.ts",
  "e2e/helpers/fixtures.ts",
  "e2e/helpers/stress.ts",
  "e2e/helpers/selectors.ts",
  "scripts/perf/config/benchmarkClasses.ts",
];
const apparatusHash = createHash("sha256");
for (const file of apparatusFiles)
  apparatusHash.update(file).update(readFileSync(path.join(root, file)));
const protocol = {
  scenario: values.scenario,
  seconds,
  rounds,
  panelCount,
  window: { width: 1728, height: 1000 },
  scale: "2",
  fontFamily: "Menlo",
  machine: {
    platform: process.platform,
    arch: process.arch,
    release: release(),
    cpu: cpus()[0]?.model,
  },
  warmupSeconds: 8,
  cpuUnit: "percent of one core",
  gpuUnit: "accumulated device GPU time / wall time, percent; not percent of all GPU cores",
  apparatusHash: apparatusHash.digest("hex"),
  sourceSha,
  diagnostic: values.trace,
  buildHash: buildHash.digest("hex"),
  classification: FOREGROUND_TERMINAL_CLASS,
};
const output = path.resolve(values.output);
mkdirSync(path.dirname(output), { recursive: true });
const results: unknown[] = [];
writeFileSync(output, JSON.stringify({ protocol, complete: false, results }, null, 2));
function counters(pids: number[]): Counters {
  return JSON.parse(
    execFileSync(
      "python3",
      [path.join(root, "scripts/perf/lib/foregroundCounters.py"), ...pids.map(String)],
      { encoding: "utf8" }
    )
  );
}

counters([]); // Reject a locked native desktop before opening a test app.
for (let round = 0; round < rounds; round++) {
  const fixture = createFixtureRepo({ name: "foreground-terminal" });
  const bin = path.join(fixture.dir, ".foreground-bin");
  mkdirSync(bin);
  const executable = path.join(bin, "claude");
  writeFileSync(executable, readFileSync(path.join(root, "scripts/perf/lib/foregroundAgent.cjs")));
  chmodSync(executable, 0o755);
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      enableWebgl: true,
      windowSize: protocol.window,
      screenshotScale: protocol.scale,
      env: { ...fakeAgentEnv(bin), FOREGROUND_MODE: mode },
    });
    // Use an installed font so asynchronous web-font arrival cannot change
    // terminal geometry between arms. This writes only the temporary profile.
    await ctx.window.evaluate(
      (fontFamily) =>
        (window as unknown as BenchWindow).__daintreeDispatchAction(
          "terminalConfig.setFontFamily",
          { fontFamily },
          { source: "test" }
        ),
      protocol.fontFamily
    );
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir);
    const page = ctx.window;
    const ids: string[] = [];
    for (let index = 0; index < panelCount; index++) {
      await page.locator(SEL.agent.trayButton).click();
      await page.locator(SEL.agent.launcherRow("Claude")).first().click();
      await expect.poll(async () => (await getGridPanelIds(page)).length).toBe(index + 1);
      const id = (await getGridPanelIds(page)).find((candidate) => !ids.includes(candidate));
      assert(id);
      ids.push(id);
      const panel = page.locator(`[data-panel-id="${id}"]`);
      await waitForTerminalTextById(page, id, "FOREGROUND_READY");
      await expect
        .poll(() => panel.getAttribute("data-detected-agent-id"), { timeout: 30000 })
        .toBe("claude");
      await expect
        .poll(() => panel.getAttribute("data-agent-state"), { timeout: 30000 })
        .toBe(mode === "idle" || mode === "typing" ? "waiting" : "working");
    }
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await delay(protocol.warmupSeconds * 1000);
    await page
      .locator(`[data-panel-id="${ids.at(-1)}"] .xterm`)
      .first()
      .click({ position: { x: 30, y: 10 } });
    assert.equal((await getGridPanelIds(page)).length, panelCount);
    const state = await page.evaluate((ids) => {
      const w = window as unknown as BenchWindow;
      w.__foregroundProbes = {};
      return ids.map((id) => {
        const term = w.__daintreeGetTerminalForE2E(id);
        const probe: Probe = {
          renders: 0,
          rows: 0,
          writes: 0,
          characters: 0,
          inputLatencies: [],
          pendingInputs: 0,
          dispose() {},
        };
        let expected = "";
        const pending: { text: string; at: number }[] = [];
        const input = term.onData((data) => {
          if (/^[a-z]$/.test(data)) {
            expected += data;
            pending.push({ text: `INPUT:${expected}`, at: performance.now() });
            probe.pendingInputs = pending.length;
          }
        });
        const render = term.onRender(({ start, end }) => {
          probe.renders++;
          probe.rows += end - start + 1;
          if (pending.length) {
            const buffer = term.buffer.active;
            let text = "";
            for (let row = buffer.baseY; row < buffer.length; row++)
              text += buffer.getLine(row)?.translateToString(true) ?? "";
            while (pending.length && text.includes(pending[0].text)) {
              probe.inputLatencies.push(performance.now() - pending.shift()!.at);
            }
            probe.pendingInputs = pending.length;
          }
        });
        const original = term.write.bind(term);
        term.write = (data, callback) => {
          probe.writes++;
          probe.characters += data.length;
          original(data, callback);
        };
        probe.dispose = () => {
          render.dispose();
          input.dispose();
          term.write = original;
        };
        w.__foregroundProbes[id] = probe;
        term.focus();
        const renderer = (
          term as unknown as {
            _core: {
              _renderService: {
                _renderer: {
                  value?: {
                    _gl?: WebGL2RenderingContext;
                    _canvas?: HTMLCanvasElement;
                  };
                };
              };
            };
          }
        )._core._renderService._renderer.value;
        return {
          id,
          cols: term.cols,
          rows: term.rows,
          webgl: w.__daintreeGetTerminalWebGLState(id),
          liveWebglCanvas: Boolean(
            renderer?._canvas?.isConnected && renderer._gl && !renderer._gl.isContextLost()
          ),
          visibility: document.visibilityState,
          powerSaving: document.body.dataset.powerSaving === "true",
          dpr: devicePixelRatio,
          fontFamily: term.options.fontFamily,
          fontSize: term.options.fontSize,
          width: term.element?.getBoundingClientRect().width,
          innerWidth,
        };
      });
    }, ids);
    assert(
      state.every(
        (entry) =>
          entry.webgl.active &&
          entry.liveWebglCanvas &&
          entry.visibility === "visible" &&
          !entry.powerSaving
      ),
      JSON.stringify(state)
    );
    await page.screenshot({ path: `${output}.${round}.png` });
    if (values.trace)
      await page.evaluate((ids) => {
        const w = window as unknown as BenchWindow;
        w.__foregroundRefreshStacks = {};
        for (const id of ids) {
          const term = w.__daintreeGetTerminalForE2E(id) as Terminal & {
            _core: {
              _renderService: {
                refreshRows(start: number, end: number, sync?: boolean, redraw?: boolean): void;
              };
            };
          };
          const service = term._core._renderService;
          const original = service.refreshRows;
          service.refreshRows = function (start, end, sync, redraw) {
            const stack = `${start}:${end}:${redraw} ${new Error().stack}`;
            w.__foregroundRefreshStacks![stack] = (w.__foregroundRefreshStacks![stack] ?? 0) + 1;
            original.call(this, start, end, sync, redraw);
          };
        }
      }, ids);
    const cdp = values.trace ? await page.context().newCDPSession(page) : null;
    if (cdp) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.start");
    }
    const processes = await ctx.app.evaluate(({ app }) =>
      app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.name }))
    );
    if (values.trace)
      await ctx.app.evaluate(async ({ contentTracing }) =>
        contentTracing.startRecording({
          included_categories: ["devtools.timeline", "v8", "blink", "cc", "gpu", "viz", "toplevel"],
        })
      );
    const before = counters(processes.map((p) => p.pid));
    assert(Object.keys(before.gpu).length > 0, "Missing per-process GPU counters");
    const start = performance.now();
    let typed = "";
    while (performance.now() - start < seconds * 1000) {
      if (mode === "typing") {
        const ch = String.fromCharCode(97 + (typed.length % 26));
        await page.keyboard.type(ch);
        typed += ch;
        await delay(200);
      } else {
        await delay(Math.min(1000, seconds * 1000 - (performance.now() - start)));
      }
    }
    const after = counters(processes.map((p) => p.pid));
    const finalState = await page.evaluate(
      (ids) =>
        ids.map((id) => {
          const w = window as unknown as BenchWindow;
          const term = w.__daintreeGetTerminalForE2E(id);
          const renderer = (
            term as unknown as {
              _core: {
                _renderService: {
                  _renderer: {
                    value?: {
                      _gl?: WebGL2RenderingContext;
                      _canvas?: HTMLCanvasElement;
                    };
                  };
                };
              };
            }
          )._core._renderService._renderer.value;
          return {
            cols: term.cols,
            rows: term.rows,
            powerSaving: document.body.dataset.powerSaving === "true",
            liveWebglCanvas: Boolean(
              renderer?._canvas?.isConnected && renderer._gl && !renderer._gl.isContextLost()
            ),
            agentState: document
              .querySelector(`[data-panel-id="${id}"]`)
              ?.getAttribute("data-agent-state"),
          };
        }),
      ids
    );
    finalState.forEach((entry, index) => {
      assert.equal(entry.cols, state[index].cols, "Terminal columns changed during measurement");
      assert.equal(entry.rows, state[index].rows, "Terminal rows changed during measurement");
      assert(entry.liveWebglCanvas, "WebGL renderer disappeared during measurement");
      assert(!entry.powerSaving, "Power-saving motion policy changed during measurement");
      if (mode !== "typing")
        assert.equal(entry.agentState, mode === "idle" ? "waiting" : "working");
    });
    const finalPids = await ctx.app.evaluate(({ app }) =>
      app
        .getAppMetrics()
        .map((m) => m.pid)
        .sort((a, b) => a - b)
    );
    assert.deepEqual(
      finalPids,
      processes.map((p) => p.pid).sort((a, b) => a - b),
      "App process topology changed"
    );
    if (values.trace) {
      writeFileSync(
        `${output}.${round}.refresh.json`,
        JSON.stringify(
          await page.evaluate(() => (window as unknown as BenchWindow).__foregroundRefreshStacks)
        )
      );
    }
    if (cdp) {
      writeFileSync(
        `${output}.${round}.cpuprofile`,
        JSON.stringify((await cdp.send("Profiler.stop")).profile)
      );
      await cdp.detach();
    }
    if (values.trace)
      await ctx.app.evaluate(
        async ({ contentTracing }, dest) => contentTracing.stopRecording(dest),
        `${output}.${round}.trace.json`
      );
    assert.deepEqual(
      Object.keys(after.gpu).sort(),
      Object.keys(before.gpu).sort(),
      "GPU clients changed during the window"
    );
    const cpuSeconds = (after.cpuTimeNs - before.cpuTimeNs) / 1e9;
    const gpuSeconds = (after.gpuTimeNs - before.gpuTimeNs) / 1e9;
    const cpu = processes.map((p) => ({
      ...p,
      percent: ((after.cpuNs[p.pid] - before.cpuNs[p.pid]) / 1e9 / cpuSeconds) * 100,
    }));
    const gpuPercent =
      (Object.keys(after.gpu).reduce(
        (sum, key) => sum + after.gpu[key].ns - before.gpu[key].ns,
        0
      ) /
        1e9 /
        gpuSeconds) *
      100;
    const probes = await page.evaluate(
      (ids) =>
        ids.map((id) => {
          const probe = (window as unknown as BenchWindow).__foregroundProbes[id];
          probe.dispose();
          return {
            id,
            renders: probe.renders,
            rows: probe.rows,
            writes: probe.writes,
            characters: probe.characters,
            inputLatencies: probe.inputLatencies,
            pendingInputs: probe.pendingInputs,
          };
        }),
      ids
    );
    const waitingLatencies: number[] = [];
    for (const id of ids) {
      const stoppedAt = performance.now();
      await page.evaluate(({ id }) => window.electron.terminal.write(id, "\x04"), { id });
      await waitForTerminalTextById(page, id, "FOREGROUND_DONE:");
      const text = await getTerminalTextById(page, id);
      const done = text.match(/FOREGROUND_DONE:(\d+):/);
      assert(done, "Missing producer completion counter");
      if (mode === "stream")
        assert(text.includes(`OUTPUT:${done[1]} `), "Last stream chunk was not delivered");
      if (typed)
        assert(
          text.replace(/\r?\n/g, "").includes(`FOREGROUND_DONE:${done[1]}:${typed}`),
          "Producer did not receive the exact input sequence"
        );
      await expect
        .poll(() => page.locator(`[data-panel-id="${id}"]`).getAttribute("data-agent-state"), {
          timeout: 30000,
        })
        .toBe("waiting");
      waitingLatencies.push(performance.now() - stoppedAt);
    }
    if (["spinner", "redundant", "stream"].includes(mode))
      assert(
        probes.every((p) => p.writes >= seconds * (mode === "stream" ? 15 : 7)),
        "Workload shortfall"
      );
    if (mode !== "idle")
      assert(
        probes.every((p) => p.renders > 0),
        "No terminal renders"
      );
    if (mode === "typing")
      assert(
        probes[0].inputLatencies.length === typed.length && probes[0].pendingInputs === 0,
        "Input did not reach a confirming render"
      );
    assert(
      cpu.every((p) => Number.isFinite(p.percent) && p.percent >= 0),
      JSON.stringify({ cpu, before, after })
    );
    assert(Number.isFinite(gpuPercent) && gpuPercent >= 0);
    const result = {
      round,
      cpuSeconds,
      gpuSeconds,
      cpuPercent: cpu.reduce((sum, p) => sum + p.percent, 0),
      gpuPercent,
      processes: cpu,
      probes,
      state,
      finalState,
      typedCharacters: typed.length,
      waitingLatencies,
      correctnessMisses: 0,
    };
    results.push(result);
    writeFileSync(
      output,
      JSON.stringify(
        {
          protocol,
          generatedAt: new Date().toISOString(),
          complete: results.length === rounds,
          results,
        },
        null,
        2
      )
    );
    console.log("FOREGROUND_RESULT", JSON.stringify(result));
  } finally {
    if (ctx) await closeApp(ctx.app);
    fixture.cleanup();
  }
}
