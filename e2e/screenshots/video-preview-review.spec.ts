/**
 * Inline video preview visual-review harness.
 *
 * `FileVideoPreview` is shared by the file panel, the file browser's viewer and
 * the diff panel, and the cases worth judging are the small ones: a tile in a
 * crowded grid, a viewer column squeezed by the tree, a wide but short row. In
 * the real app each of those means rearranging the grid between shots, so this
 * drives the component's own preview entry (`video-preview-preview.html`): the
 * real component inside each pane's body box, at an exact size, against the real
 * theme tokens and `index.css`.
 *
 * The clips are encoded at run time with ffmpeg (required) as VP8 WebM, since
 * Playwright's Chromium ships without H.264.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_VIDEOPREVIEW=1 DAINTREE_SHOT_DIR=/tmp/video-preview \
 *     npx playwright test --project=screenshots video-preview-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_VIDEOPREVIEW  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR           output directory (default artifacts/video-preview-shots)
 *   DAINTREE_SHOT_THEMES        comma-separated theme sweep for the sheet state
 *                               (default: daintree,bondi,namib,svalbard)
 *
 * Each PNG gets a JSON sidecar with the measured geometry — the video's box,
 * the stage's padding, and whether the scroll body overflows — because "is the
 * control bar inside the pane" is a number before it is a judgement.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_VIDEOPREVIEW;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "video-preview-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib,svalbard")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

type Host = "file-pane" | "file-browser" | "diff-pane" | "file-dialog";
type Fixture = "landscape" | "portrait" | "probing";

interface Shot {
  name: string;
  host: Host;
  fixture: Fixture;
  width: number;
  height: number;
  what: string;
  /** Hold the probe past the skeleton hint's first threshold (8s) so its copy shows. */
  withHint?: boolean;
}

const SHOTS: Shot[] = [
  {
    name: "file-pane-landscape-comfortable",
    host: "file-pane",
    fixture: "landscape",
    width: 900,
    height: 560,
    what: "a roomy pane — must not regress",
  },
  {
    name: "file-pane-landscape-tile",
    host: "file-pane",
    fixture: "landscape",
    width: 480,
    height: 300,
    what: "a tile in a 3x3 grid",
  },
  {
    name: "file-pane-landscape-tiny",
    host: "file-pane",
    fixture: "landscape",
    width: 340,
    height: 220,
    what: "the smallest pane worth defending",
  },
  {
    name: "file-pane-landscape-short-row",
    host: "file-pane",
    fixture: "landscape",
    width: 1000,
    height: 300,
    what: "wide but short — height binds",
  },
  {
    name: "file-pane-portrait-tile",
    host: "file-pane",
    fixture: "portrait",
    width: 480,
    height: 420,
    what: "a phone recording",
  },
  {
    name: "file-browser-landscape-column",
    host: "file-browser",
    fixture: "landscape",
    width: 420,
    height: 320,
    what: "viewer column beside a wide tree",
  },
  {
    name: "diff-pane-landscape-tile",
    host: "diff-pane",
    fixture: "landscape",
    width: 480,
    height: 300,
    what: "the diff panel's media branch",
  },
  {
    name: "file-pane-probing-tile",
    host: "file-pane",
    fixture: "probing",
    width: 480,
    height: 300,
    what: "the size probe on a cold disk",
  },
  {
    name: "file-pane-probing-hint-short-row",
    host: "file-pane",
    fixture: "probing",
    width: 1000,
    height: 300,
    what: "a slow probe with its hint, height-bound",
    withHint: true,
  },
  {
    name: "file-pane-probing-hint-tile",
    host: "file-pane",
    fixture: "probing",
    width: 480,
    height: 300,
    what: "a slow probe with its hint, width-bound",
    withHint: true,
  },
  // `file.view` opens the file panel in a 6xl dialog capped at 85vh of a 900px window.
  {
    name: "file-dialog-landscape",
    host: "file-dialog",
    fixture: "landscape",
    width: 1152,
    height: 765,
    what: "a content-sized dialog — must not regress",
  },
  {
    name: "file-dialog-probing",
    host: "file-dialog",
    fixture: "probing",
    width: 1152,
    height: 765,
    what: "the probe in a dialog with no height to fill",
  },
  {
    name: "file-dialog-portrait",
    host: "file-dialog",
    fixture: "portrait",
    width: 1152,
    height: 765,
    what: "a phone recording in the dialog",
  },
];

/** The skeleton's delayed pulse starts at opacity 0; pin it visible for the shot. */
const POLISH_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
  .animate-pulse-delayed { animation: none !important; opacity: 1 !important; }
`;

let server: PreviewServer | undefined;
let fixtureDir = "";

test.use({ deviceScaleFactor: 2 });

test.beforeAll(async () => {
  // No test.skip here: `test.info()` is unavailable in a beforeAll hook, so the
  // structured-skip annotation the repo requires cannot be attached. The test
  // body carries the skip; this hook simply does no work when the flag is unset.
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  fixtureDir = mkdtempSync(path.join(tmpdir(), "video-preview-fixtures-"));
  for (const [name, size] of [
    ["landscape", "1920x1080"],
    ["portrait", "1080x1920"],
  ] as const) {
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=${size}:rate=10:duration=2`,
      "-c:v",
      "libvpx",
      "-b:v",
      "1M",
      "-y",
      path.join(fixtureDir, `${name}.webm`),
    ]);
  }

  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

async function open(page: Page, shot: Shot, theme: string): Promise<Locator> {
  await page.setViewportSize({ width: shot.width + 32, height: shot.height + 32 });
  await page.goto(
    `${server!.baseURL}/video-preview-preview.html?theme=${theme}&host=${shot.host}` +
      `&fixture=${shot.fixture}&width=${shot.width}&height=${shot.height}`
  );
  await page.addStyleTag({ content: POLISH_CSS });
  const shell = page.locator("[data-preview-shell]").first();
  await expect(shell).toBeAttached();

  if (shot.fixture === "probing") {
    await expect(
      shell.getByRole("status").or(shell.locator("[aria-busy='true']")).first()
    ).toBeAttached();
    if (shot.withHint) {
      await expect(shell.locator(".animate-hint-fade-in").first()).toBeAttached({
        timeout: 15_000,
      });
    }
  } else {
    const video = shell.locator("video");
    await expect(video).toHaveCount(1);
    // A `preload="metadata"` element parked after a seek keeps the native
    // loading spinner over the frame, which no one sees at rest in the app. A
    // play-pause round trip buffers it fully; the seek then lands on decoded
    // content rather than a black first frame.
    await video.evaluate(async (el: HTMLVideoElement) => {
      if (el.readyState < 1) {
        await new Promise<void>((resolve, reject) => {
          el.addEventListener("loadedmetadata", () => resolve(), { once: true });
          el.addEventListener("error", () => reject(new Error(`video error: ${el.src}`)), {
            once: true,
          });
        });
      }
      await el.play();
      el.pause();
      await new Promise<void>((resolve) => {
        el.addEventListener("seeked", () => resolve(), { once: true });
        el.currentTime = 0.6;
      });
    });
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 15_000 })
      .toBe(4);
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return shell;
}

async function measure(shell: Locator) {
  return shell.evaluate((root) => {
    const scroll = Array.from(root.querySelectorAll<HTMLElement>("*")).find((el) => {
      const o = getComputedStyle(el).overflow;
      return o.includes("auto") || o.includes("scroll");
    });
    const stage = root.querySelector<HTMLElement>("video")?.parentElement ?? null;
    const video = root.querySelector("video");
    const rootBox = root.getBoundingClientRect();
    const rel = (r: DOMRect) => ({
      x: Math.round(r.x - rootBox.x),
      y: Math.round(r.y - rootBox.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    });
    const stageStyle = stage ? getComputedStyle(stage) : null;
    return {
      pane: { width: Math.round(rootBox.width), height: Math.round(rootBox.height) },
      video: video ? rel(video.getBoundingClientRect()) : null,
      videoIntrinsic: video ? { width: video.videoWidth, height: video.videoHeight } : null,
      videoBottomInsidePane: video
        ? video.getBoundingClientRect().bottom <= rootBox.bottom + 0.5
        : null,
      stagePadding: stageStyle
        ? [
            stageStyle.paddingTop,
            stageStyle.paddingRight,
            stageStyle.paddingBottom,
            stageStyle.paddingLeft,
          ]
        : null,
      stageMinHeight: stageStyle?.minHeight ?? null,
      scroll: scroll
        ? {
            clientHeight: scroll.clientHeight,
            scrollHeight: scroll.scrollHeight,
            clientWidth: scroll.clientWidth,
            scrollWidth: scroll.scrollWidth,
            overflowsY: scroll.scrollHeight > scroll.clientHeight + 1,
            overflowsX: scroll.scrollWidth > scroll.clientWidth + 1,
          }
        : null,
      videoAreaShare: video
        ? Number(
            (
              (video.getBoundingClientRect().width * video.getBoundingClientRect().height) /
              (rootBox.width * rootBox.height)
            ).toFixed(3)
          )
        : null,
    };
  });
}

test("video preview — pane sizes, hosts and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_VIDEOPREVIEW is required for the video preview capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_VIDEOPREVIEW=1 to run the capture");

  await stubViteHmrClient(page);
  await page.route("**/__video-fixtures/*", (route) => {
    const file = path.join(fixtureDir, path.basename(new URL(route.request().url()).pathname));
    return route.fulfill({ path: file, contentType: "video/webm" });
  });

  const snap = makeSnap(OUT_DIR);
  const written: string[] = [];
  const record = async (shell: Locator, file: string, shot: Shot, theme: string) => {
    written.push(await snap(shell, `${file}.png`));
    const metrics = await measure(shell);
    writeFileSync(
      path.join(OUT_DIR, `${file}.json`),
      JSON.stringify({ ...shot, theme, ...metrics }, null, 2)
    );
  };

  const defaultTheme = THEMES[0]!;
  for (const shot of SHOTS) {
    const shell = await open(page, shot, defaultTheme);
    await record(shell, shot.name, shot, defaultTheme);
  }

  // The stage is theme-neutral apart from the canvas and the skeleton bone, so
  // the sweep runs on one small state only and gets tiled into a sheet.
  const sweep = SHOTS.find((s) => s.name === "file-pane-landscape-tile")!;
  for (const theme of THEMES.slice(1)) {
    const shell = await open(page, sweep, theme);
    await record(shell, `theme-${theme}-${sweep.name}`, sweep, theme);
  }

  // Count the files ourselves. A harness that trusts its own exit code is how a
  // review ends up reasoning about screenshots that were never written.
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(SHOTS.length + THEMES.length - 1);
  console.log(`[video-preview-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
