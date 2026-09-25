import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CAPTURE_WIDTH,
  PREVIEW_HANDLE,
  cuesInOrder,
  type CanvasRect,
  type PreviewSnapshot,
  type TourPreviewConfig,
  type TourPreviewHandle,
} from "./protocol.js";

/** The slice of playwright-core capture drives, so tests can fake it. */
export interface CaptureElement {
  screenshot(options: { path: string }): Promise<unknown>;
}
export interface CapturePage {
  goto(url: string): Promise<unknown>;
  waitForFunction(fn: string, arg?: unknown, options?: { timeout?: number }): Promise<unknown>;
  evaluate<R>(fn: string): Promise<R>;
  waitForTimeout(ms: number): Promise<void>;
  $(selector: string): Promise<CaptureElement | null>;
}
export interface CaptureBrowser {
  newPage(options: {
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
    reducedMotion?: "reduce" | "no-preference";
  }): Promise<CapturePage>;
  close(): Promise<void>;
}
export interface Playwright {
  chromium: { launch(options: { headless: boolean }): Promise<CaptureBrowser> };
}

/**
 * `playwright-core` is optional, so installing the CLI never downloads a
 * browser. Looked up next to the CLI first, then in the plugin project.
 */
export async function loadPlaywright(pluginDir: string): Promise<Playwright> {
  try {
    return (await import("playwright-core")) as unknown as Playwright;
  } catch {
    // Not installed beside the CLI.
  }
  try {
    const resolved = createRequire(path.join(pluginDir, "package.json")).resolve("playwright-core");
    return (await import(pathToFileURL(resolved).href)) as unknown as Playwright;
  } catch {
    throw new Error(
      "Headless capture needs playwright-core and a Chromium build: npm install --save-dev playwright-core && npx playwright-core install chromium"
    );
  }
}

export interface CaptureFrame {
  /** null for the chapter's opening frame, at 0s. */
  cue: string | null;
  time: number;
  /** Relative to the capture directory. */
  file: string;
  anchors: Record<string, CanvasRect>;
}

export interface CaptureChapter {
  id: string;
  duration: number;
  timingSource: TourPreviewConfig["chapters"][number]["timingSource"];
  undefinedCues: string[];
  error?: string;
  frames: CaptureFrame[];
}

export interface CaptureManifest {
  version: 1;
  tourId: string;
  /** Frames show each cue's settled state: this long after seeking to it. */
  settleMs: number;
  canvas: { width: number; height: number };
  scale: number;
  chapters: CaptureChapter[];
  warnings: string[];
}

export interface CaptureOptions {
  url: string;
  config: TourPreviewConfig;
  outDir: string;
  settleMs: number;
  playwright: Playwright;
  log?: (line: string) => void;
}

const LOAD_TIMEOUT_MS = 30_000;

function call(method: keyof TourPreviewHandle, arg?: unknown): string {
  return `window.${PREVIEW_HANDLE}.${method}(${arg === undefined ? "" : JSON.stringify(arg)})`;
}

function frameName(index: number, cue: string | null): string {
  return `${String(index).padStart(2, "0")}-${cue ?? "start"}.png`;
}

/**
 * Open every chapter and screenshot the stage at 0s and at each cue, in firing
 * order, paused and settled. Anchor rectangles go into the manifest beside
 * each frame, so a reviewer can check the cursor and highlights land where the
 * narration says without watching.
 */
export async function captureTour(opts: CaptureOptions): Promise<CaptureManifest> {
  const log = opts.log ?? (() => {});
  let browser: CaptureBrowser;
  try {
    browser = await opts.playwright.chromium.launch({ headless: true });
  } catch (error) {
    const message = (error as Error).message;
    if (/Executable doesn't exist|browserType\.launch.*install/is.test(message)) {
      throw new Error(
        "playwright-core has no Chromium to launch; install one with: npx playwright-core install chromium",
        { cause: error }
      );
    }
    throw error;
  }
  try {
    const page = await browser.newPage({
      viewport: { width: CAPTURE_WIDTH, height: (CAPTURE_WIDTH * 9) / 16 },
      deviceScaleFactor: 1,
      reducedMotion: "no-preference",
    });
    await page.goto(`${opts.url}?capture=1`);
    await page.waitForFunction(
      `window.${PREVIEW_HANDLE}?.ready || window.${PREVIEW_HANDLE}?.error`,
      undefined,
      { timeout: LOAD_TIMEOUT_MS }
    );
    const error = await page.evaluate<string | null>(`window.${PREVIEW_HANDLE}.error`);
    if (error) throw new Error(error);

    await fs.mkdir(opts.outDir, { recursive: true });
    const chapters: CaptureChapter[] = [];
    let canvas = { width: 0, height: 0 };
    for (const chapter of opts.config.chapters) {
      log(`→ ${chapter.id}: capturing`);
      await page.evaluate(call("goTo", chapter.id));
      const stops = [{ cue: null, time: 0 }, ...cuesInOrder(chapter.timing.cues)];
      const frames: CaptureFrame[] = [];
      let snapshot: PreviewSnapshot | null = null;
      for (const [index, stop] of stops.entries()) {
        await page.evaluate(call("seek", stop.time));
        await page.waitForTimeout(opts.settleMs);
        snapshot = await page.evaluate<PreviewSnapshot>(call("snapshot"));
        canvas = snapshot.canvas;
        const file = path.posix.join(chapter.id, frameName(index, stop.cue));
        await fs.mkdir(path.join(opts.outDir, chapter.id), { recursive: true });
        const stage = await page.$(".tp-stage");
        if (!stage) throw new Error(`Chapter "${chapter.id}" rendered no tour stage`);
        await stage.screenshot({ path: path.join(opts.outDir, file) });
        frames.push({ cue: stop.cue, time: stop.time, file, anchors: snapshot.anchors });
      }
      chapters.push({
        id: chapter.id,
        duration: chapter.timing.duration,
        timingSource: chapter.timingSource,
        undefinedCues: snapshot?.report.undefinedCues ?? [],
        ...(snapshot?.report.error ? { error: snapshot.report.error } : {}),
        frames,
      });
    }

    const manifest: CaptureManifest = {
      version: 1,
      tourId: opts.config.tourId,
      settleMs: opts.settleMs,
      canvas,
      scale: canvas.width > 0 ? CAPTURE_WIDTH / canvas.width : 0,
      chapters,
      warnings: [
        ...opts.config.warnings,
        ...chapters.flatMap((c) => [
          ...c.undefinedCues.map(
            (cue) =>
              `Chapter "${c.id}": a scene waits on cue "${cue}", which the narration doesn't mark, so it never fires`
          ),
          ...(c.error ? [`Chapter "${c.id}": the scene threw: ${c.error}`] : []),
        ]),
      ],
    };
    await fs.writeFile(
      path.join(opts.outDir, "capture.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    return manifest;
  } finally {
    await browser.close().catch(() => {});
  }
}
