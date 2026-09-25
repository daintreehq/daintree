import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("../tour/preview/vendor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tour/preview/vendor.js")>();
  return {
    ...actual,
    // Bundling React is covered by tourPreviewVendor.test.ts; here it only has to be served.
    buildVendorGraph: vi.fn(async () => ({
      files: new Map([["react.js", "export const useState = 1;"]]),
      imports: { react: "/_preview/vendor/react.js" },
      tourFiles: [],
    })),
  };
});

import { loadTourPreview, runTourPreview } from "../commands/tourPreview.js";
import { narrationFingerprint, parseNarration } from "../../../tour/src/tourNarration.js";
import {
  cuesInOrder,
  pinTiming,
  recordCueReads,
  sceneMapProblem,
  undefinedCues,
  type TourPreviewConfig,
} from "../tour/preview/protocol.js";
import { renderShell } from "../tour/preview/shell.js";
import { TourPlayer } from "../../../tour/src/TourPlayer.js";
import { compilePreviewCss, previewTheme } from "../tour/preview/styles.js";
import type { CapturePage, Playwright } from "../tour/preview/capture.js";

const NARRATION = {
  chapters: [
    { id: "intro", narration: "Welcome to the [[panel]] panel, [[close]] then close it." },
    { id: "wrap", narration: "That is [[done]] everything." },
  ],
};

function fingerprint(id: string): string {
  const chapter = NARRATION.chapters.find((c) => c.id === id)!;
  return narrationFingerprint(parseNarration(chapter.narration));
}

const INTRO_TIMING = {
  id: "intro",
  duration: 4,
  cues: { panel: 1.5, close: 1.5 },
  captions: [{ start: 0, end: 3.9, text: "Welcome to the panel, then close it." }],
  audioUrl: "tours/welcome/intro a.ogg",
  narrationHash: fingerprint("intro"),
};

let tmpDir: string;
let harnessDir: string;

async function writePlugin(chapters: unknown[], { built = true } = {}) {
  const tour = { id: "welcome", title: "Welcome", componentPath: "dist/tour.js", chapters };
  await fs.writeFile(
    path.join(tmpDir, "plugin.json"),
    JSON.stringify({ name: "acme.demo", version: "1.0.0", contributes: { tours: [tour] } })
  );
  await fs.mkdir(path.join(tmpDir, "tours"), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, "tours", "welcome.narration.json"),
    JSON.stringify(NARRATION)
  );
  if (built) {
    await fs.mkdir(path.join(tmpDir, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "dist", "tour.js"),
      'export default {}; const cls = "bg-surface-panel absolute";\n'
    );
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-tour-preview-"));
  harnessDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-tour-harness-"));
  await fs.writeFile(path.join(harnessDir, "harness.js"), "export {};\n");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(harnessDir, { recursive: true, force: true });
});

describe("loadTourPreview", () => {
  it("plays committed timing as-is and estimates chapters that were never voiced", async () => {
    await writePlugin([INTRO_TIMING]);
    const { config } = await loadTourPreview({ dir: tmpDir });

    expect(config.tourId).toBe("welcome");
    expect(config.componentUrl).toBe("/plugin/dist/tour.js");
    const [intro, wrap] = config.chapters;
    expect(intro).toMatchObject({
      id: "intro",
      timingSource: "manifest",
      narrationCues: ["panel", "close"],
      timing: { duration: 4, cues: { panel: 1.5, close: 1.5 } },
    });
    expect(intro!.timing.audioUrl).toBe("/plugin/tours/welcome/intro%20a.ogg");
    expect(wrap!.timingSource).toBe("estimate");
    expect(wrap!.timing.audioUrl).toBeNull();
    expect(Object.keys(wrap!.timing.cues)).toEqual(["done"]);
    expect(config.warnings).toEqual([
      expect.stringMatching(/Chapter "wrap": no timing yet; previewing estimated timing/),
    ]);
  });

  it("warns about timing made from different narration, and previews it anyway", async () => {
    await writePlugin([
      { ...INTRO_TIMING, narrationHash: "00000000", audioUrl: "https://cdn.example.com/a.ogg" },
      {
        id: "wrap",
        duration: 2,
        cues: { done: 1 },
        audioUrl: null,
        narrationHash: fingerprint("wrap"),
      },
    ]);
    const { config } = await loadTourPreview({ dir: tmpDir });
    expect(config.chapters.map((c) => c.timingSource)).toEqual(["stale", "manifest"]);
    expect(config.chapters[0]!.timing.audioUrl).toBe("https://cdn.example.com/a.ogg");
    // Schema defaults fill what the manifest left out.
    expect(config.chapters[1]!.timing.captions).toEqual([]);
    expect(config.warnings).toEqual([
      expect.stringMatching(/Chapter "intro": timing is stale against the narration/),
    ]);
  });

  it("previews only the chapters asked for", async () => {
    await writePlugin([INTRO_TIMING]);
    const { config } = await loadTourPreview({ dir: tmpDir, only: ["intro"] });
    expect(config.chapters.map((c) => c.id)).toEqual(["intro"]);
    expect(config.warnings).toEqual([]);
  });

  it("asks for a build when the tour module doesn't exist yet", async () => {
    await writePlugin([INTRO_TIMING], { built: false });
    await expect(loadTourPreview({ dir: tmpDir })).rejects.toThrow(
      "The tour's componentPath dist/tour.js doesn't exist yet; build the plugin first (npm run build)"
    );
  });
});

describe("preview protocol", () => {
  it("records every cue a scene looks up, without changing what it reads", () => {
    const reads: string[] = [];
    const cues = recordCueReads({ panel: 1 }, (cue) => reads.push(cue));
    expect(cues.panel).toBe(1);
    expect(cues.ghost).toBeUndefined();
    expect(Object.keys(cues)).toEqual(["panel"]);
    expect(reads).toEqual(["panel", "ghost"]);
  });

  it("reports only cues the narration doesn't mark", () => {
    expect(undefinedCues(["panel", "ghost", "ghost", "alpha"], ["panel", "close"])).toEqual([
      "alpha",
      "ghost",
    ]);
  });

  it("holds the tour module to its scene map contract", () => {
    const Scene = () => null;
    const memo = { $$typeof: Symbol.for("react.memo"), type: Scene };
    expect(
      sceneMapProblem({ default: { intro: Scene, wrap: memo } }, ["intro", "wrap"])
    ).toBeNull();
    expect(sceneMapProblem({}, ["intro"])).toMatch(/must default-export an object/);
    expect(sceneMapProblem({ default: Scene }, ["intro"])).toMatch(/must default-export an object/);
    expect(sceneMapProblem({ default: [Scene] }, ["intro"])).toMatch(/must default-export/);
    expect(sceneMapProblem({ default: { intro: Scene } }, ["intro", "wrap"])).toBe(
      `The tour module's default export has no scene for "wrap"`
    );
    expect(sceneMapProblem({ default: { intro: "Scene" } }, ["intro"])).toBe(
      `The scene for "intro" is not a React component`
    );
  });

  it("keeps each chapter's scene on its own cue table after the player moves on", () => {
    const timing = (cue: string) => ({
      duration: 2,
      cues: { [cue]: 1 },
      captions: [],
      audioUrl: null,
    });
    const timings = [timing("panel"), timing("done")];
    const player = new TourPlayer(timings, {
      createAudio: () => {
        throw new Error("no audio");
      },
      now: () => 0,
      requestFrame: () => 0,
      cancelFrame: () => {},
    });
    const [intro, wrap] = timings.map((t) => pinTiming(player, t));
    intro!.seek(1.5);
    expect(player.getTime()).toBe(1.5);

    player.goTo(1);
    expect(player.timing.cues).toEqual({ done: 1 });
    expect(intro!.timing.cues).toEqual({ panel: 1 });
    expect(wrap!.timing.cues).toEqual({ done: 1 });
    // Everything else is the live player.
    expect(intro!.getState().chapterIndex).toBe(1);
    expect(intro!.chapterCount).toBe(2);
  });

  it("orders cues by firing time, ties by id", () => {
    expect(cuesInOrder({ b: 2, close: 1.5, panel: 1.5, a: 0 })).toEqual([
      { cue: "a", time: 0 },
      { cue: "close", time: 1.5 },
      { cue: "panel", time: 1.5 },
      { cue: "b", time: 2 },
    ]);
  });
});

describe("preview page", () => {
  it("embeds the import map and a config that can't close its script element", () => {
    const config: TourPreviewConfig = {
      version: 1,
      tourId: "welcome",
      title: "Welcome </script><b>",
      componentUrl: "/plugin/dist/tour.js",
      chapters: [],
      warnings: [],
    };
    const html = renderShell(config, { react: "/_preview/vendor/react.js" }, "light");
    expect(html).toContain(
      '<script type="importmap">{"imports":{"react":"/_preview/vendor/react.js"}}</script>'
    );
    expect(html).toContain('<html lang="en" class="light"');
    expect(html).not.toContain("</script><b>");
    expect(html).toContain("<title>Welcome &#60;/script&#62;&#60;b&#62; — tour preview</title>");
  });

  it("styles the classes the scenes use against the chosen theme", async () => {
    const source = path.join(tmpDir, "scene.js");
    await fs.writeFile(source, 'const c = "bg-surface-panel bg-red-500 absolute";');
    const theme = previewTheme("daintree");
    expect(theme.css).toContain("--theme-surface-canvas:");
    const css = await compilePreviewCss([source], theme);
    expect(css).toContain(".bg-surface-panel");
    expect(css).toContain(".absolute");
    // The design contract removes Tailwind's stock palette, as it does in the host.
    expect(css).not.toContain(".bg-red-500");
    // Preflight, which the host document carries and a plugin sheet never does.
    expect(css).toContain("box-sizing: border-box");
    expect(css).toContain(".tour-click-ring");
  });

  it("names the built-in themes when given an unknown one", () => {
    expect(() => previewTheme("nope")).toThrow(/Unknown theme "nope"; built-in themes: .*daintree/);
  });
});

interface FakeCall {
  kind: string;
  arg?: unknown;
}

function fakePlaywright(options: { pageError?: string; launchError?: Error } = {}) {
  const calls: FakeCall[] = [];
  let chapter = "";
  let time = 0;
  const page: CapturePage = {
    goto: async (url) => {
      calls.push({ kind: "goto", arg: url });
      // The page is real: fetch it so the server is proven to serve it.
      const res = await fetch(url);
      calls.push({ kind: "status", arg: res.status });
    },
    waitForFunction: async () => {},
    waitForTimeout: async (ms) => {
      calls.push({ kind: "wait", arg: ms });
    },
    evaluate: (async (fn: string) => {
      if (fn.endsWith(".error")) return options.pageError ?? null;
      const goTo = /\.goTo\("([^"]+)"\)$/.exec(fn);
      if (goTo) {
        chapter = goTo[1]!;
        calls.push({ kind: "goTo", arg: chapter });
        return;
      }
      const seek = /\.seek\(([\d.]+)\)$/.exec(fn);
      if (seek) {
        time = Number(seek[1]);
        calls.push({ kind: "seek", arg: time });
        return;
      }
      if (fn.endsWith(".snapshot()")) {
        return {
          chapterId: chapter,
          time,
          canvas: { width: 640, height: 360 },
          anchors: { button: { x: time, y: 0, width: 10, height: 10 } },
          report: { chapterId: chapter, undefinedCues: chapter === "intro" ? ["ghost"] : [] },
        };
      }
      throw new Error(`unexpected evaluate: ${fn}`);
    }) as CapturePage["evaluate"],
    $: async () => ({
      screenshot: async ({ path: file }: { path: string }) => {
        calls.push({ kind: "shot", arg: file });
        await fs.writeFile(file, "png");
      },
    }),
  };
  const close = vi.fn(async () => {});
  const playwright: Playwright = {
    chromium: {
      launch: async () => {
        if (options.launchError) throw options.launchError;
        return { newPage: async () => page, close };
      },
    },
  };
  return { playwright, calls, close };
}

describe("runTourPreview", () => {
  it("captures a settled frame at the start and at each cue of every chapter", async () => {
    await writePlugin([INTRO_TIMING]);
    const out = path.join(tmpDir, "frames");
    const { playwright, calls, close } = fakePlaywright();
    const log = vi.fn();

    const result = await runTourPreview({
      dir: tmpDir,
      headless: true,
      out,
      settleMs: 5,
      harnessDir,
      playwright,
      log,
    });

    expect(calls.find((c) => c.kind === "goto")!.arg).toBe(`${result.url}?capture=1`);
    expect(calls.find((c) => c.kind === "status")!.arg).toBe(200);
    const steps = calls
      .filter((c) => c.kind === "goTo" || c.kind === "seek")
      .map((c) => `${c.kind}:${String(c.arg)}`);
    expect(steps.slice(0, 4)).toEqual(["goTo:intro", "seek:0", "seek:1.5", "seek:1.5"]);
    expect(steps[4]).toBe("goTo:wrap");
    expect(calls.filter((c) => c.kind === "wait").every((c) => c.arg === 5)).toBe(true);

    const manifest = JSON.parse(await fs.readFile(path.join(out, "capture.json"), "utf8"));
    expect(manifest).toMatchObject({ version: 1, tourId: "welcome", settleMs: 5, scale: 2 });
    const intro = manifest.chapters[0];
    expect(intro.frames.map((f: { file: string; cue: string | null }) => [f.file, f.cue])).toEqual([
      ["intro/00-start.png", null],
      ["intro/01-close.png", "close"],
      ["intro/02-panel.png", "panel"],
    ]);
    expect(intro.frames[1].anchors.button.x).toBe(1.5);
    expect(intro.undefinedCues).toEqual(["ghost"]);
    for (const frame of intro.frames) {
      expect(await fs.readFile(path.join(out, frame.file), "utf8")).toBe("png");
    }
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Chapter "wrap": no timing yet/),
        expect.stringMatching(/Chapter "intro": a scene waits on cue "ghost"/),
      ])
    );
    expect(result.capture?.manifestPath).toBe(path.join(out, "capture.json"));
    expect(close).toHaveBeenCalled();
    // The server is gone once the command returns.
    await expect(fetch(result.url)).rejects.toThrow();
  });

  it("fails with the page's own error and still closes the browser", async () => {
    await writePlugin([INTRO_TIMING]);
    const { playwright, close } = fakePlaywright({
      pageError: "The tour module must default-export",
    });
    await expect(
      runTourPreview({ dir: tmpDir, headless: true, out: tmpDir, harnessDir, playwright })
    ).rejects.toThrow("The tour module must default-export");
    expect(close).toHaveBeenCalled();
  });

  it("explains how to get a browser when Chromium isn't installed", async () => {
    await writePlugin([INTRO_TIMING]);
    const { playwright } = fakePlaywright({
      launchError: new Error("browserType.launch: Executable doesn't exist at /x/chrome"),
    });
    await expect(
      runTourPreview({ dir: tmpDir, headless: true, out: tmpDir, harnessDir, playwright })
    ).rejects.toThrow("npx playwright-core install chromium");
  });

  it("needs somewhere to write frames in headless mode", async () => {
    await expect(runTourPreview({ dir: tmpDir, headless: true })).rejects.toThrow(
      "--headless needs --out <dir>"
    );
  });

  it("serves the page until stopped, relaying what the page reports", async () => {
    await writePlugin([INTRO_TIMING]);
    const controller = new AbortController();
    const log = vi.fn();
    let pageHtml = "";
    let css = "";
    const done = runTourPreview({
      dir: tmpDir,
      harnessDir,
      signal: controller.signal,
      log,
      onListening: (url) => {
        void (async () => {
          pageHtml = await (await fetch(url)).text();
          css = await (await fetch(new URL("/_preview/styles.css", url))).text();
          const harness = await fetch(new URL("/_preview/harness/harness.js", url));
          expect(harness.status).toBe(200);
          const vendor = await fetch(new URL("/_preview/vendor/react.js", url));
          expect(await vendor.text()).toBe("export const useState = 1;");
          await fetch(new URL("/_preview/report", url), {
            method: "POST",
            body: JSON.stringify({ chapterId: "intro", undefinedCues: ["ghost"] }),
          });
          controller.abort();
        })();
      },
    });
    const result = await done;
    expect(pageHtml).toContain('"componentUrl":"/plugin/dist/tour.js"');
    // Classes found in the plugin's built module are compiled.
    expect(css).toContain(".bg-surface-panel");
    expect(result.warnings).toContain(
      `Chapter "intro": a scene waits on cue "ghost", which the narration doesn't mark, so it never fires`
    );
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^! Chapter "intro": a scene waits/));
  });

  it("refuses to start without the built preview page", async () => {
    await writePlugin([INTRO_TIMING]);
    await expect(
      runTourPreview({ dir: tmpDir, harnessDir: path.join(tmpDir, "missing") })
    ).rejects.toThrow(/The preview page is missing from/);
  });
});
