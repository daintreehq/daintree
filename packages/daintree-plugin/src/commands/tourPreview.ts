import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TourChapterSchema } from "../../../../electron/schemas/plugin.js";
import { estimateTiming } from "../../../tour/src/tourNarration.js";
import type { TourChapterTiming } from "../../../tour/src/tourTypes.js";
import {
  captureTour,
  loadPlaywright,
  type CaptureManifest,
  type Playwright,
} from "../tour/preview/capture.js";
import type { PreviewChapter, TourPreviewConfig } from "../tour/preview/protocol.js";
import { PLUGIN_PATH, startTourPreviewServer, type PreviewAsset } from "../tour/preview/server.js";
import { HARNESS_PATH, STYLES_PATH, renderShell } from "../tour/preview/shell.js";
import { compilePreviewCss, listScripts, previewTheme } from "../tour/preview/styles.js";
import { VENDOR_PATH, buildVendorGraph } from "../tour/preview/vendor.js";
import { isStaleTiming, loadTour, type TourCommonOptions } from "./tour.js";

export interface TourPreviewOptions extends Pick<
  TourCommonOptions,
  "dir" | "tour" | "narration" | "only" | "log"
> {
  /** Built-in theme id (default: daintree). */
  theme?: string;
  /** Port to listen on; 0 (the default) picks a free one. */
  port?: number;
  /** Capture a frame at each cue into `out` instead of serving until stopped. */
  headless?: boolean;
  /** Capture directory, required with `headless`. */
  out?: string;
  /** Milliseconds to let a scene settle after each seek before capturing (default 750). */
  settleMs?: number;
  /** Interactive mode serves until this aborts, so it is required there; headless capture stops at the next frame. */
  signal?: AbortSignal;
  /** Called once the server is listening. */
  onListening?: (url: string) => void;
  /** Directory holding the built harness (default: next to this module). Injected in tests. */
  harnessDir?: string;
  /** Injected in tests. */
  playwright?: Playwright;
}

export interface TourPreviewResult {
  tourId: string;
  url: string;
  /** Stale or missing timing, then anything the page reported. */
  warnings: string[];
  capture?: { dir: string; manifestPath: string; manifest: CaptureManifest };
}

function chapterWarnings(chapter: PreviewChapter): string[] {
  if (chapter.timingSource === "stale") {
    return [
      `Chapter "${chapter.id}": timing is stale against the narration; previewing the old timing until you re-run tour voice or tour align`,
    ];
  }
  if (chapter.timingSource === "estimate") {
    return [
      `Chapter "${chapter.id}": no timing yet; previewing estimated timing without audio (run tour voice or tour align)`,
    ];
  }
  return [];
}

function isRemote(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url);
}

function pageAudioUrl(audioUrl: string | null): string | null {
  if (audioUrl === null || isRemote(audioUrl)) return audioUrl;
  return `${PLUGIN_PATH}${audioUrl.split("/").map(encodeURIComponent).join("/")}`;
}

/** A regular file inside the plugin, which is all the preview server will serve. */
async function isPluginFile(dir: string, file: string): Promise<boolean> {
  try {
    const [root, real] = await Promise.all([fs.realpath(dir), fs.realpath(file)]);
    const relative = path.relative(root, real);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
    return (await fs.stat(real)).isFile();
  } catch {
    return false;
  }
}

/** What the page plays: each chapter's committed timing, or an estimate, with what's wrong with it. */
export async function loadTourPreview(opts: TourPreviewOptions): Promise<{
  dir: string;
  config: TourPreviewConfig;
}> {
  const ctx = await loadTour(opts);
  const componentPath = ctx.tour.componentPath;
  if (typeof componentPath !== "string" || componentPath.length === 0) {
    throw new Error(`Tour "${ctx.tour.id}" has no componentPath in plugin.json`);
  }
  const componentFile = path.resolve(ctx.dir, componentPath);
  if (!(await isPluginFile(ctx.dir, componentFile))) {
    throw new Error(
      `The tour's componentPath ${componentPath} doesn't exist yet; build the plugin first (npm run build)`
    );
  }

  const chapters: PreviewChapter[] = ctx.chapters
    .filter((chapter) => !opts.only || opts.only.includes(chapter.id))
    .map((chapter) => {
      const entry = ctx.entries.get(chapter.id);
      let timing: TourChapterTiming;
      let timingSource: PreviewChapter["timingSource"];
      if (entry) {
        const parsed = TourChapterSchema.parse(entry);
        timing = {
          duration: parsed.duration,
          cues: parsed.cues,
          captions: parsed.captions,
          audioUrl: parsed.audioUrl,
        };
        timingSource = isStaleTiming(entry, chapter) ? "stale" : "manifest";
      } else {
        timing = estimateTiming(chapter.narration);
        timingSource = "estimate";
      }
      return {
        id: chapter.id,
        narrationCues: Object.keys(chapter.parsed.cueWordIndex),
        timing: { ...timing, audioUrl: pageAudioUrl(timing.audioUrl) },
        timingSource,
      };
    });

  const warnings = chapters.flatMap(chapterWarnings);
  for (const chapter of chapters) {
    const entry = ctx.entries.get(chapter.id);
    const audioUrl = typeof entry?.audioUrl === "string" ? entry.audioUrl : null;
    if (
      audioUrl &&
      !isRemote(audioUrl) &&
      !(await isPluginFile(ctx.dir, path.resolve(ctx.dir, audioUrl)))
    ) {
      warnings.push(
        `Chapter "${chapter.id}": its audio ${audioUrl} is missing, so it plays silently`
      );
    }
  }

  const title = typeof ctx.tour.title === "string" ? ctx.tour.title : ctx.tour.id;
  return {
    dir: ctx.dir,
    config: {
      version: 1,
      tourId: ctx.tour.id,
      title,
      componentUrl: `${PLUGIN_PATH}${componentPath.split("/").map(encodeURIComponent).join("/")}`,
      chapters,
      warnings,
    },
  };
}

function defaultHarnessDir(): string {
  // tsup emits every entry at the root of dist/, beside dist/tour-preview/.
  return fileURLToPath(new URL("./tour-preview/", import.meta.url));
}

async function harnessAssets(dir: string): Promise<Map<string, PreviewAsset>> {
  const assets = new Map<string, PreviewAsset>();
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    files = [];
  }
  for (const name of files) {
    if (!name.endsWith(".js")) continue;
    assets.set(`${path.posix.dirname(HARNESS_PATH)}/${name}`, {
      body: await fs.readFile(path.join(dir, name)),
      type: "text/javascript; charset=utf-8",
    });
  }
  if (!assets.has(HARNESS_PATH)) {
    throw new Error(
      `The preview page is missing from ${dir}; this daintree-plugin install is incomplete`
    );
  }
  return assets;
}

/** `--out` must be a directory, or not exist yet; checked before a browser is started. */
async function requireDirectory(dir: string): Promise<void> {
  try {
    if (!(await fs.stat(dir)).isDirectory()) {
      throw new Error(`--out ${dir} is a file; it must name a directory`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal || signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true })
  );
}

/**
 * Serve the plugin's tour for playing and scrubbing in a browser, without
 * Daintree: its built scenes, its committed timing and audio, cue markers on
 * the timeline and outlines on every named anchor. With `headless`, capture a
 * frame at each cue into `out` instead.
 */
export async function runTourPreview(opts: TourPreviewOptions = {}): Promise<TourPreviewResult> {
  if (opts.headless && !opts.out) throw new Error("--headless needs --out <dir> for the frames");
  if (!opts.headless && !opts.signal) {
    throw new Error("An interactive preview needs a signal to stop it; pass one, or use headless");
  }
  if (opts.out) await requireDirectory(path.resolve(opts.out));
  const log = opts.log ?? (() => {});
  const { dir, config } = await loadTourPreview(opts);
  const theme = previewTheme(opts.theme ?? "daintree");
  const playwright = opts.headless ? (opts.playwright ?? (await loadPlaywright(dir))) : undefined;

  const vendor = await buildVendorGraph(dir);
  const assets = await harnessAssets(opts.harnessDir ?? defaultHarnessDir());
  // The whole plugin rather than the module's folder: a scene module imports
  // chunks from wherever the build put them, and there's no DOM observer here
  // to catch a class the scan missed.
  const sources = [...(await listScripts(dir)), ...vendor.tourFiles];
  assets.set(STYLES_PATH, {
    body: await compilePreviewCss(sources, theme),
    type: "text/css; charset=utf-8",
  });
  for (const [name, text] of vendor.files) {
    assets.set(`${VENDOR_PATH}${name}`, { body: text, type: "text/javascript; charset=utf-8" });
  }

  const warnings = [...config.warnings];
  for (const warning of warnings) log(`! ${warning}`);
  const reported = new Set<string>();
  const warn = (line: string) => {
    if (reported.has(line)) return;
    reported.add(line);
    warnings.push(line);
    log(`! ${line}`);
  };

  const server = await startTourPreviewServer({
    pluginDir: dir,
    html: renderShell(config, vendor.imports, theme.type),
    assets,
    port: opts.port,
    onReport: (report) => {
      for (const cue of report.undefinedCues) {
        warn(
          `Chapter "${report.chapterId}": a scene waits on cue "${cue}", which the narration doesn't mark, so it never fires`
        );
      }
      if (report.error) warn(`Chapter "${report.chapterId}": the scene threw: ${report.error}`);
    },
  });
  try {
    opts.onListening?.(server.url);
    if (!playwright) {
      await waitForAbort(opts.signal);
      return { tourId: config.tourId, url: server.url, warnings };
    }
    const outDir = path.resolve(opts.out!);
    const manifest = await captureTour({
      url: server.url,
      config,
      outDir,
      settleMs: opts.settleMs ?? 750,
      playwright,
      log,
      signal: opts.signal,
    });
    for (const line of manifest.warnings) {
      if (!warnings.includes(line)) warnings.push(line);
    }
    return {
      tourId: config.tourId,
      url: server.url,
      warnings,
      capture: { dir: outDir, manifestPath: path.join(outDir, "capture.json"), manifest },
    };
  } finally {
    await server.close();
  }
}
