/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
import { test, expect, type Page } from "@playwright/test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { launchApp, closeApp, getActiveAppWindow, type AppContext } from "../../helpers/launch";
import { openAndOnboardProject } from "../../helpers/project";
import { addAndSwitchToProject } from "../../helpers/workflows";
import { createSwitchFixture, type SwitchFixture } from "../../helpers/switchFixture";
import { getGridPanelIds, openTerminal } from "../../helpers/panels";
import { ptyWrite } from "../../helpers/fakeAgent";
import { T_LONG } from "../../helpers/timeouts";

// Diagnostic harness for the wrong-glyph file tree after a project switch
// back (#12169 regression window). Not a gate: it reports, never asserts on
// the pixels. Each project gets a file browser panel (tree expanded down to a
// revealed file, git badges, Markdown in the viewer) and a shell pane; the
// tree column's raw bitmap is captured through webContents.capturePage() as a
// baseline, then the app rotates A -> B -> A with several dwell times and
// re-captures the tree at a few delays after the return. The DOM text is read
// alongside every capture so a pixel diff with identical text is a
// raster-level fault, not a re-render.
//   RUN_GLYPH_REPRO=1 npx playwright test --project=full-resilience \
//     e2e/full/resilience/file-browser-glyph-repro.spec.ts
// Knobs (all env): GLYPH_REPRO_DWELLS (ms list), GLYPH_REPRO_HOPS (returns
// per dwell), GLYPH_REPRO_OUT (capture dir), GLYPH_REPRO_STREAM=1 (a busy
// shell loop in every terminal), GLYPH_REPRO_DIRTY=0 / GLYPH_REPRO_MD=0 (drop
// the badges / the Markdown reveal), GLYPH_REPRO_GPU_PRESSURE=1 (CDP
// Memory.simulatePressureNotification during the dwell — browser + GPU
// process purge), GLYPH_REPRO_MINIMIZE=1 (minimise the window while away),
// GLYPH_REPRO_TRACE=1 (Chromium trace of the dwell, counts
// MemoryPurgeManager / FontCache::Invalidate events), GLYPH_REPRO_EXTRA_ARGS
// (Chromium switches; Electron merges --enable-features with its own).
// Caveats learned the hard way: a cached view's document never reports
// hidden here — nor does one in a minimised window, so Playwright's focus
// emulation is forcing page visibility — and Blink's MemoryPurgeInBackground
// purge does not fire under this harness (trace-verified), so the 1-4 min
// production purge is out of reach. capturePage() is not a passive observer
// of the first presented frame, and after GLYPH_REPRO_MINIMIZE=1 it never
// resolves (the restored window is still hidden to macOS), so that knob only
// works with an external frame capture. Starting a Chromium trace as a switch
// begins stalls the switch. Real page visibility (a cached view reporting
// `hidden`, its renderer backgrounded) needs a driver that attaches without
// Playwright's emulation, i.e. raw CDP on --remote-debugging-port; that is
// outside this spec.
const OUT_DIR =
  process.env.GLYPH_REPRO_OUT ??
  path.join(process.cwd(), ".tmp", "glyph-repro", String(Date.now()));
const DWELLS_MS = (process.env.GLYPH_REPRO_DWELLS ?? "1500,8000,30000")
  .split(",")
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v) && v >= 0);
const CAPTURE_DELAYS_MS = [0, 250, 1000, 3000];
const PROJECT_COUNT = 3;
const HOPS_PER_DWELL = Number(process.env.GLYPH_REPRO_HOPS ?? PROJECT_COUNT);
const GPU_PRESSURE = process.env.GLYPH_REPRO_GPU_PRESSURE === "1";
const STREAM_TERMINAL = process.env.GLYPH_REPRO_STREAM === "1";
const DIRTY_TREE = process.env.GLYPH_REPRO_DIRTY !== "0";
const REVEAL_MARKDOWN = process.env.GLYPH_REPRO_MD !== "0";
const MINIMIZE_DURING_DWELL = process.env.GLYPH_REPRO_MINIMIZE === "1";
const TRACE_DWELL = process.env.GLYPH_REPRO_TRACE === "1";
const CACHE_CAP = 5;
// Any channel off by more than this counts as a differing pixel. Text raster
// is deterministic for identical DOM + geometry, so this only absorbs the
// compositor's rounding, not a glyph swap.
const CHANNEL_TOLERANCE = 12;

const repro = process.env.RUN_GLYPH_REPRO === "1" ? test.describe.serial : test.describe.skip;

interface Bitmap {
  width: number;
  height: number;
  scale: number;
  bgra: Buffer;
  png: Buffer;
}

interface TreeCapture {
  projectId: string;
  label: string;
  bitmap: Bitmap | null;
  rowText: string[];
  error?: string;
}

interface DiffResult {
  differing: number;
  total: number;
  fraction: number;
  firstRow: number;
  lastRow: number;
}

let ctx: AppContext;
let fixture: SwitchFixture | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureOutDir(): void {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
}

async function dispatchOn(page: Page, actionId: string, args?: unknown): Promise<any> {
  return page.evaluate(
    async ([id, payload]) => {
      const fn = (window as any).__daintreeDispatchAction;
      if (typeof fn !== "function") return { ok: false, error: { message: "no dispatch bridge" } };
      return fn(id, payload, { source: "test" });
    },
    [actionId, args] as const
  );
}

async function getAttachedProjectId(): Promise<string | null> {
  return ctx.app.evaluate(async () => {
    const g = globalThis as Record<string, unknown>;
    const pvm = (g.__daintreeGetPvm as (() => any) | undefined)?.();
    return (pvm?.activeProjectId as string | undefined) ?? null;
  });
}

async function waitForAttached(projectId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await getAttachedProjectId()) === projectId) return true;
    await sleep(10);
  }
  return false;
}

async function pageForProject(projectId: string): Promise<Page> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const page = await getActiveAppWindow(ctx.app, 60_000, { requireProject: true });
    const id = await page
      .evaluate(() => (window as any).__DAINTREE_INITIAL_PROJECT__?.id ?? null)
      .catch(() => null);
    if (id === projectId) return page;
    await sleep(100);
  }
  throw new Error(`active page never resolved to project ${projectId}`);
}

/** Run a script inside a (possibly hidden, cached) project view. */
async function evaluateInProjectView<T>(projectId: string, script: string): Promise<T | null> {
  return ctx.app.evaluate(
    async (_electron, { projectId, script }) => {
      const g = globalThis as Record<string, unknown>;
      const pvm = (g.__daintreeGetPvm as (() => any) | undefined)?.();
      const entry = pvm?.getAllViews?.().find((v: any) => v.projectId === projectId);
      const wc = entry?.view?.webContents as Electron.WebContents | undefined;
      if (!wc || wc.isDestroyed()) return null;
      try {
        return (await Promise.race([
          wc.executeJavaScript(script, true),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("view eval timeout")), 10_000)
          ),
        ])) as T;
      } catch {
        return null;
      }
    },
    { projectId, script }
  );
}

interface HiddenProbe {
  vis: string;
  hidden: boolean;
  usedMb: number;
  totalMb: number;
}

const HIDDEN_PROBE_SCRIPT = `(() => {
  const m = performance.memory;
  return {
    vis: document.visibilityState,
    hidden: document.hidden,
    usedMb: m ? Math.round(m.usedJSHeapSize / 1048576) : -1,
    totalMb: m ? Math.round(m.totalJSHeapSize / 1048576) : -1,
  };
})()`;

/**
 * Dwell away from `projectId`, sampling its cached renderer every few seconds.
 * The heap drop ~15 s in is Daintree's own HeapProfiler.collectGarbage timer,
 * not evidence of a Blink purge — use GLYPH_REPRO_TRACE=1 for that.
 */
async function dwellWithProbe(projectId: string, label: string, dwellMs: number): Promise<void> {
  const started = Date.now();
  const samples: string[] = [];
  let minTotal = Number.POSITIVE_INFINITY;
  let maxTotal = 0;
  const setMinimized = (minimized: boolean) =>
    ctx.app.evaluate(({ BrowserWindow }, minimized) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win || win.isDestroyed()) return;
      if (minimized) win.minimize();
      else win.restore();
    }, minimized);
  if (MINIMIZE_DURING_DWELL) await setMinimized(true);
  if (TRACE_DWELL) {
    await ctx.app.evaluate(async ({ contentTracing }) => {
      await contentTracing.startRecording({
        included_categories: ["blink", "fonts", "disabled-by-default-memory-infra"],
        excluded_categories: ["*"],
      });
    });
  }
  while (Date.now() - started < dwellMs) {
    if (MINIMIZE_DURING_DWELL && dwellMs - (Date.now() - started) <= 3_000) {
      await setMinimized(false);
    }
    const remaining = dwellMs - (Date.now() - started);
    await sleep(Math.min(5_000, Math.max(0, remaining)));
    if (GPU_PRESSURE) {
      // Browser-process pressure: Chromium forwards it to the GPU process
      // (Ganesh purgeUnlockedResources on the shared context, glyph atlas
      // included) and the network service, never to the renderer. Real OS
      // pressure on a loaded machine takes the same path.
      const sent = await ctx.app.evaluate(
        async (_electron, { projectId }) => {
          const g = globalThis as Record<string, unknown>;
          const pvm = (g.__daintreeGetPvm as (() => any) | undefined)?.();
          const entry = pvm?.getAllViews?.().find((v: any) => v.projectId === projectId);
          const wc = entry?.view?.webContents as Electron.WebContents | undefined;
          if (!wc || wc.isDestroyed()) return "no-wc";
          try {
            if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
            await wc.debugger.sendCommand("Memory.simulatePressureNotification", {
              level: "critical",
            });
            return "ok";
          } catch (error) {
            return `error: ${String(error)}`;
          }
        },
        { projectId }
      );
      if (sent !== "ok") console.log(`[glyph] gpu pressure: ${sent}`);
    }
    const probe = await evaluateInProjectView<HiddenProbe>(projectId, HIDDEN_PROBE_SCRIPT);
    if (!probe) continue;
    minTotal = Math.min(minTotal, probe.totalMb);
    maxTotal = Math.max(maxTotal, probe.totalMb);
    samples.push(
      `${Math.round((Date.now() - started) / 1000)}s:${probe.vis[0]}/${probe.usedMb}/${probe.totalMb}`
    );
  }
  console.log(
    `[glyph] dwell ${label} ${dwellMs}ms hidden-probe (t:vis/usedMb/totalMb) total ${maxTotal}->${minTotal}: ${samples.join(" ")}`
  );
  if (TRACE_DWELL) {
    ensureOutDir();
    const tracePath = path.join(OUT_DIR, `trace-${label}.json`);
    const written = await ctx.app.evaluate(async ({ contentTracing }, tracePath) => {
      const file = await contentTracing.stopRecording(tracePath);
      return file;
    }, tracePath);
    const text = readFileSync(written, "utf8");
    const count = (needle: string) => text.split(needle).length - 1;
    console.log(
      `[glyph] trace ${label}: PerformMemoryPurge=${count("PerformMemoryPurge")} FontCache::Invalidate=${count("FontCache::Invalidate")} bytes=${text.length} -> ${written}`
    );
  }
}

/**
 * Capture the file-browser tree column of a project's view straight from the
 * compositor. Runs in main so the pixels are what viz actually presented for
 * this WebContentsView, GPU-rasterised tiles included.
 */
async function captureTree(projectId: string, label: string): Promise<TreeCapture> {
  const result = await ctx.app.evaluate(
    async (_electron, { projectId }) => {
      const g = globalThis as Record<string, unknown>;
      const pvm = (g.__daintreeGetPvm as (() => any) | undefined)?.();
      const entry = pvm?.getAllViews?.().find((v: any) => v.projectId === projectId);
      const wc = entry?.view?.webContents as Electron.WebContents | undefined;
      if (!wc || wc.isDestroyed()) return { error: "no webContents for project" };
      const probe = await wc.executeJavaScript(
        `(() => {
          const col = document.querySelector('[data-testid="file-browser-tree-column"]');
          const tree = col?.querySelector('[role="tree"]');
          if (!col || !tree) return { error: "no tree column" };
          const r = col.getBoundingClientRect();
          const rows = Array.from(tree.querySelectorAll('[role="treeitem"]')).map(
            (el) => (el.textContent ?? "").replace(/\\s+/g, " ").trim()
          );
          return {
            rect: { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) },
            rows,
            scale: window.devicePixelRatio,
          };
        })()`,
        true
      );
      if (probe?.error) return { error: probe.error };
      const image = await wc.capturePage(probe.rect);
      const size = image.getSize();
      if (image.isEmpty() || size.width === 0) return { error: "empty capture", rows: probe.rows };
      return {
        rows: probe.rows as string[],
        scale: probe.scale as number,
        width: size.width,
        height: size.height,
        bgra: image.toBitmap().toString("base64"),
        png: image.toPNG().toString("base64"),
      };
    },
    { projectId }
  );
  if (result.error) {
    return { projectId, label, bitmap: null, rowText: result.rows ?? [], error: result.error };
  }
  return {
    projectId,
    label,
    rowText: result.rows,
    bitmap: {
      width: result.width,
      height: result.height,
      scale: result.scale,
      bgra: Buffer.from(result.bgra, "base64"),
      png: Buffer.from(result.png, "base64"),
    },
  };
}

function diffBitmaps(a: Bitmap, b: Bitmap): DiffResult | null {
  if (a.width !== b.width || a.height !== b.height) return null;
  const total = a.width * a.height;
  let differing = 0;
  let firstRow = -1;
  let lastRow = -1;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    if (
      Math.abs(a.bgra[o] - b.bgra[o]) > CHANNEL_TOLERANCE ||
      Math.abs(a.bgra[o + 1] - b.bgra[o + 1]) > CHANNEL_TOLERANCE ||
      Math.abs(a.bgra[o + 2] - b.bgra[o + 2]) > CHANNEL_TOLERANCE
    ) {
      differing++;
      const row = Math.floor(i / a.width);
      if (firstRow < 0) firstRow = row;
      lastRow = row;
    }
  }
  return { differing, total, fraction: differing / total, firstRow, lastRow };
}

function savePng(capture: TreeCapture, name: string): string | null {
  if (!capture.bitmap) return null;
  ensureOutDir();
  const file = path.join(OUT_DIR, `${name}.png`);
  writeFileSync(file, capture.bitmap.png);
  return file;
}

async function openFileBrowserPanel(page: Page, revealPath: string): Promise<void> {
  let worktreeId: string | undefined;
  await expect
    .poll(
      async () => {
        const listed = await dispatchOn(page, "worktree.list");
        worktreeId = (listed.result?.worktrees ?? []).find((w: any) => w.isMain)?.id;
        return worktreeId ?? null;
      },
      { timeout: T_LONG }
    )
    .not.toBeNull();
  const opened = await dispatchOn(page, "worktree.openFileBrowserPanel", {
    worktreeId,
    revealPath,
    revealKind: "file",
  });
  if (opened?.ok === false) {
    throw new Error(`openFileBrowserPanel failed: ${opened.error?.message ?? "unknown"}`);
  }
  const tree = page.locator('[data-testid="file-browser-tree-column"] [role="tree"]');
  await expect(tree).toBeVisible({ timeout: T_LONG });
  await expect
    .poll(() => tree.locator('[role="treeitem"]').count(), { timeout: T_LONG })
    .toBeGreaterThan(12);
}

interface ProjectInfo {
  id: string;
  name: string;
  path: string;
}

interface Finding {
  target: string;
  dwellMs: number;
  delayMs: number;
  fraction: number;
  rowsDiffer: [number, number];
  textChanged: boolean;
  file: string | null;
}

repro("Resilience: file browser glyph corruption after a warm switch back", () => {
  test.beforeAll(async () => {
    fixture = createSwitchFixture({
      projects: PROJECT_COUNT,
      worktreesPerProject: 1,
      filesPerRepo: 180,
      streamLinesPerSec: 0,
    });
    // Real GPU: the fault lives in the raster/composite path, and the default
    // E2E launch runs the window through the software rasteriser.
    // Chromium switches for discriminating runs, e.g.
    //   GLYPH_REPRO_EXTRA_ARGS="--enable-features=MemoryPurgeInBackground:memory_purge_background_min_delay/5s/memory_purge_background_max_delay/6s"
    // pulls the hidden renderer's background memory purge (1-4 min by
    // default) inside a short dwell.
    const extraArgs = (process.env.GLYPH_REPRO_EXTRA_ARGS ?? "")
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    ctx = await launchApp({ env: fixture.launchEnv, enableWebgl: true, extraArgs });
    const features = await ctx.app.evaluate(({ app }) => ({
      enable: app.commandLine.getSwitchValue("enable-features"),
      disable: app.commandLine.getSwitchValue("disable-features"),
    }));
    console.log(`[glyph] features enable="${features.enable}" disable="${features.disable}"`);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixture?.cleanup();
  });

  test("tree pixels survive A -> B -> A with unchanged DOM text", async () => {
    test.setTimeout(1_200_000);
    const fx = fixture!;
    ensureOutDir();
    console.log(`[glyph] output: ${OUT_DIR}`);

    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fx.projects[0]!.dir);
    await ctx.app.evaluate((_electron, limit) => {
      const g = globalThis as Record<string, unknown>;
      const pvm = (g.__daintreeGetPvm as (() => any) | undefined)?.();
      pvm?.setLowMemoryFreeThresholdMb?.(null);
      pvm?.setCachedViewLimit?.(limit);
    }, CACHE_CAP);

    const resolveProject = async (dir: string): Promise<ProjectInfo> => {
      const all: ProjectInfo[] = await ctx.window.evaluate(() =>
        (window as any).electron.project.getAll()
      );
      const base = path.basename(dir);
      const hit = all.find((p) => path.basename(p.path) === base);
      if (!hit) throw new Error(`project for ${dir} not registered`);
      return hit;
    };

    const projects: ProjectInfo[] = [];
    for (let i = 0; i < fx.projects.length; i++) {
      const project = fx.projects[i]!;
      if (i > 0) {
        ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, project.dir, project.name);
      }
      const info = await resolveProject(project.dir);
      const panelsBefore = new Set(await getGridPanelIds(ctx.window));
      await openTerminal(ctx.window);
      if (STREAM_TERMINAL) {
        const fresh = (await getGridPanelIds(ctx.window)).filter((id) => !panelsBefore.has(id));
        const terminalId = fresh[fresh.length - 1];
        if (terminalId) {
          await sleep(1_500);
          // Keeps the xterm WebGL renderer busy in every project, hidden or not,
          // the way a streaming agent does.
          await ptyWrite(
            ctx.window,
            terminalId,
            'while :; do echo "stream $RANDOM $(date +%T.%N)"; sleep 0.05; done\r'
          );
        }
      }
      const module = `src/module-0${Math.min(i + 2, 9)}`;
      await openFileBrowserPanel(ctx.window, `${module}/unit-07.ts`);
      if (DIRTY_TREE) {
        // Uncommitted edits give the tree git-status badges, which are the
        // rows' only `font-bold` text and the only user of the bundled 700 face.
        for (const rel of [`${module}/unit-01.ts`, `${module}/unit-04.ts`, "README.md"]) {
          appendFileSync(path.join(project.dir, rel), `\n// dirty ${Date.now()}\n`);
        }
        writeFileSync(path.join(project.dir, module, "untracked-note.md"), "# scratch\n");
      }
      if (REVEAL_MARKDOWN) {
        // Re-target the same panel at a Markdown file so the viewer renders
        // prose beside the tree, as in the reported screenshot. The expanded
        // folders from the first reveal stay open.
        await sleep(1_000);
        await openFileBrowserPanel(ctx.window, "README.md");
      }
      projects.push(info);
      console.log(`[glyph] seeded ${project.name} (${info.id})`);
    }
    // Let fonts, git status badges and the viewer settle before the baseline.
    await sleep(4_000);

    const baselines = new Map<string, TreeCapture>();
    for (const project of [...projects].reverse()) {
      const page = await getActiveAppWindow(ctx.app, 60_000, { requireProject: true });
      await dispatchOn(page, "project.switch", { projectId: project.id });
      expect(await waitForAttached(project.id, 60_000)).toBe(true);
      await sleep(2_500);
      const capture = await captureTree(project.id, "baseline");
      expect(capture.error, `baseline capture for ${project.name}`).toBeUndefined();
      baselines.set(project.id, capture);
      savePng(capture, `${project.name}-baseline`);
      console.log(
        `[glyph] baseline ${project.name}: ${capture.bitmap!.width}x${capture.bitmap!.height} @${capture.bitmap!.scale}x rows=${capture.rowText.length}`
      );
    }

    const findings: Finding[] = [];
    // Current attached project is projects[0] (last visited in the loop above).
    let current = projects[0]!;
    for (const dwellMs of DWELLS_MS) {
      for (let hop = 0; hop < HOPS_PER_DWELL; hop++) {
        const away = projects.find((p) => p.id !== current.id)!;
        const target = current;

        let page = await pageForProject(current.id);
        await dispatchOn(page, "project.switch", { projectId: away.id });
        expect(await waitForAttached(away.id, 60_000)).toBe(true);
        await dwellWithProbe(target.id, `${target.name}-dwell${dwellMs}-hop${hop}`, dwellMs);

        page = await pageForProject(away.id);
        // Do not wrap this switch in contentTracing.startRecording: starting a
        // trace as the switch begins stalls the switch indefinitely (seen twice).
        await dispatchOn(page, "project.switch", { projectId: target.id });
        expect(await waitForAttached(target.id, 60_000)).toBe(true);

        const baseline = baselines.get(target.id)!;
        let previousDelay = 0;
        for (const delayMs of CAPTURE_DELAYS_MS) {
          await sleep(delayMs - previousDelay);
          previousDelay = delayMs;
          const capture = await captureTree(target.id, `dwell${dwellMs}-delay${delayMs}`);
          if (capture.error || !capture.bitmap) {
            console.log(
              `[glyph] capture failed (${capture.error}) dwell=${dwellMs} delay=${delayMs}`
            );
            continue;
          }
          const diff = diffBitmaps(baseline.bitmap!, capture.bitmap);
          const textChanged = JSON.stringify(capture.rowText) !== JSON.stringify(baseline.rowText);
          const tag = `${target.name}-dwell${dwellMs}-hop${hop}-delay${delayMs}`;
          if (!diff) {
            const file = savePng(capture, `${tag}-RESIZED`);
            console.log(`[glyph] ${tag}: size changed -> ${file}`);
            continue;
          }
          const suspicious = diff.fraction > 0.002;
          const file = suspicious || delayMs === 0 ? savePng(capture, tag) : null;
          console.log(
            `[glyph] ${tag}: diff=${(diff.fraction * 100).toFixed(3)}% (${diff.differing}px rows ${diff.firstRow}-${diff.lastRow}) text=${textChanged ? "CHANGED" : "same"}${file ? ` -> ${file}` : ""}`
          );
          if (suspicious) {
            findings.push({
              target: target.name,
              dwellMs,
              delayMs,
              fraction: diff.fraction,
              rowsDiffer: [diff.firstRow, diff.lastRow],
              textChanged,
              file,
            });
          }
        }
        // Advance so the next hop returns to a different project.
        const next = projects[(projects.indexOf(target) + 1) % projects.length]!;
        page = await pageForProject(target.id);
        await dispatchOn(page, "project.switch", { projectId: next.id });
        expect(await waitForAttached(next.id, 60_000)).toBe(true);
        await sleep(1_000);
        current = next;
      }
    }

    const summaryPath = path.join(OUT_DIR, "findings.json");
    writeFileSync(summaryPath, JSON.stringify({ dwells: DWELLS_MS, findings }, null, 2));
    console.log(`[glyph] ${findings.length} suspicious captures -> ${summaryPath}`);
    for (const f of findings) {
      console.log(
        `[glyph]   ${f.target} dwell=${f.dwellMs} delay=${f.delayMs} diff=${(f.fraction * 100).toFixed(2)}% rows=${f.rowsDiffer.join("-")} text=${f.textChanged ? "changed" : "same"} ${f.file ?? ""}`
      );
    }
    // Reporting harness: the assertion is only that the apparatus worked.
    expect(baselines.size).toBe(PROJECT_COUNT);
  });
});
