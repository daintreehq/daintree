/**
 * Inline audio player visual-review harness.
 *
 * Drives `audio-player-preview.html`: the real `FileAudioPreview` in copies of
 * the file panel body and the file browser's media stage, at pane widths that
 * straddle the native control's 300px floor. Below the floor the player
 * scrolls sideways, so each narrow width is captured at rest and scrolled to
 * the end, with scrollbars drawn (a classic-scrollbar platform) and hidden
 * (macOS overlay scrollbars at rest).
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_AUDIOPLAYER=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots audio-player-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_AUDIOPLAYER  required — enables the capture
 *   DAINTREE_SHOT_DIR          required — absolute output dir. No default: an
 *                              in-repo fallback would put PNGs into someone's tree.
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 2)
 *
 * Output: <dir>/<host>-<width>-<theme>[-<variant>].png, each with a .json
 * sidecar of the scroller's measurements, plus manifest.json.
 */

import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import path from "path";
import { makeSnap, startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_AUDIOPLAYER;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const SCALE = Number(process.env.DAINTREE_SCREENSHOT_SCALE ?? "2");

type Host = "file-pane" | "file-browser";
type Scrollbars = "drawn" | "hidden";

interface Shot {
  host: Host;
  width: number;
  theme: string;
  state?: "ready" | "probing";
  scrolled?: boolean;
  scrollbars?: Scrollbars;
  forcedColors?: boolean;
}

function shotName(s: Shot): string {
  const variant = [
    s.state === "probing" ? "probing" : null,
    s.scrolled ? "scrolled" : null,
    s.scrollbars === "hidden" ? "overlay" : null,
    s.forcedColors ? "forced-colors" : null,
  ].filter(Boolean);
  return [s.host, s.width, s.theme, ...variant].join("-");
}

const HOSTS: Host[] = ["file-pane", "file-browser"];
const SWEEP_WIDTHS = [240, 270, 300, 312, 340, 480];
const NARROW = [240, 270];

const SHOTS: Shot[] = [
  ...HOSTS.flatMap((host) => SWEEP_WIDTHS.map((width) => ({ host, width, theme: "daintree" }))),
  ...HOSTS.flatMap((host) =>
    NARROW.map((width) => ({ host, width, theme: "daintree", scrolled: true }))
  ),
  ...HOSTS.map((host) => ({ host, width: 270, theme: "daintree", scrollbars: "hidden" as const })),
  ...HOSTS.map((host) => ({
    host,
    width: 270,
    theme: "daintree",
    scrolled: true,
    scrollbars: "hidden" as const,
  })),
  { host: "file-browser", width: 270, theme: "svalbard" },
  { host: "file-browser", width: 270, theme: "svalbard", scrolled: true },
  { host: "file-browser", width: 480, theme: "svalbard" },
  { host: "file-browser", width: 270, theme: "daintree", state: "probing" },
  { host: "file-browser", width: 270, theme: "daintree", forcedColors: true },
];

const POLISH_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
  .animate-pulse-delayed { animation: none !important; opacity: 1 !important; }
`;

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
const browsers: Partial<Record<Scrollbars, Browser>> = {};

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!OUT_DIR) throw new Error("DAINTREE_SHOT_DIR must be set to a directory outside the repo");
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
  // Playwright launches headless Chromium with --hide-scrollbars, which is what
  // a macOS overlay scrollbar looks like at rest. The drawn pass removes it to
  // show where a classic scrollbar lands.
  browsers.hidden = await chromium.launch();
  browsers.drawn = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });

  // Vite's dependency optimizer re-bundles after the first page asks for the
  // graph and force-reloads it. Hold a throwaway page until navigations stop.
  const warm = await browsers.drawn.newPage();
  let lastNav = Date.now();
  warm.on("framenavigated", () => (lastNav = Date.now()));
  await stubViteHmrClient(warm);
  await warm.goto(`${server.baseURL}/audio-player-preview.html`);
  const deadline = Date.now() + 60_000;
  while (Date.now() - lastNav < 4_000 && Date.now() < deadline) {
    await warm.waitForTimeout(500); // e2e-wait: ok — polling for the optimizer reload to stop
  }
  await warm.close();
});

test.afterAll(async () => {
  await browsers.drawn?.close();
  await browsers.hidden?.close();
  await server?.close();
});

/** Two frames, so the native control's shadow tree has laid out after metadata. */
async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

/** The nearest horizontal scroller around the player, and where the player sits in it. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const body = document.querySelector("[data-preview-body]");
    const subject =
      body?.querySelector("audio") ?? body?.querySelector('[aria-label="Loading audio"]');
    if (!body || !subject) return null;
    let scroller: Element | null = subject.parentElement;
    while (scroller && scroller !== body) {
      const ox = getComputedStyle(scroller).overflowX;
      if ((ox === "auto" || ox === "scroll") && scroller.scrollWidth > scroller.clientWidth) break;
      scroller = scroller.parentElement;
    }
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
    };
    const bodyBox = box(body);
    const subjectBox = box(subject);
    const scrolling = scroller && scroller !== body ? scroller : null;
    return {
      gutter: document.documentElement.style.getPropertyValue("--app-scrollbar-gutter"),
      body: bodyBox,
      subject: subjectBox,
      scroller: scrolling
        ? {
            className: scrolling.className,
            box: box(scrolling),
            clientWidth: scrolling.clientWidth,
            clientHeight: scrolling.clientHeight,
            offsetHeight: (scrolling as HTMLElement).offsetHeight,
            scrollWidth: scrolling.scrollWidth,
            scrollLeft: scrolling.scrollLeft,
          }
        : null,
      // Negative means part of the player sits left of the pane where no scroll
      // position can reach it.
      startGap: subjectBox.left - bodyBox.left,
      endGap: bodyBox.right - subjectBox.right,
    };
  });
}

async function capture(shot: Shot): Promise<string> {
  const browser = browsers[shot.scrollbars ?? "drawn"]!;
  const context = await browser.newContext({ deviceScaleFactor: SCALE });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  try {
    await stubViteHmrClient(page);
    if (shot.forcedColors) await page.emulateMedia({ forcedColors: "active" });
    await page.setViewportSize({ width: shot.width + 40, height: 400 });
    const query = new URLSearchParams({
      theme: shot.theme,
      host: shot.host,
      width: String(shot.width),
      state: shot.state ?? "ready",
    });
    await page.goto(`${server!.baseURL}/audio-player-preview.html?${query}`);
    await page.addStyleTag({ content: POLISH_CSS });
    if (shot.scrollbars === "hidden") {
      // --hide-scrollbars stops the bar painting but the gutter probe still
      // measures the classic width; macOS overlay scrollbars measure 0.
      await page.evaluate(() =>
        document.documentElement.style.setProperty("--app-scrollbar-gutter", "0px")
      );
    }
    const shell = page.locator("[data-preview-shell]");
    await expect(shell).toBeAttached({ timeout: 30_000 });

    if (shot.state === "probing") {
      await expect(page.locator('[aria-label="Loading audio"]')).toBeAttached();
    } else {
      const audio = page.locator("[data-preview-body] audio");
      await expect(audio).toBeAttached();
      await expect
        .poll(() => audio.evaluate((el) => (el as HTMLAudioElement).readyState), {
          message: "audio metadata never loaded",
          timeout: 15_000,
        })
        .toBeGreaterThanOrEqual(1);
      await expect
        .poll(() => audio.evaluate((el) => Math.round((el as HTMLAudioElement).duration)))
        .toBe(180);
      // The native controls re-lay out their closed shadow tree about a second
      // after metadata — at the narrowest widths the panel shrinks then — and
      // nothing outside the shadow root can observe it settle.
      await page.waitForTimeout(1_500); // e2e-wait: ok — native media controls relayout settle
    }
    await settleFrames(page);

    if (shot.scrolled) {
      const moved = await page.evaluate(() => {
        const body = document.querySelector("[data-preview-body]");
        let el = body?.querySelector("audio")?.parentElement ?? null;
        while (el && el !== body) {
          if (el.scrollWidth > el.clientWidth) {
            el.scrollLeft = el.scrollWidth;
            return el.scrollLeft;
          }
          el = el.parentElement;
        }
        return 0;
      });
      if (moved <= 0) throw new Error(`${shotName(shot)}: nothing scrolled — refusing to write`);
      await settleFrames(page);
    }

    if (errors.length > 0) throw new Error(`${shotName(shot)}: page errors: ${errors.join("; ")}`);
    const name = shotName(shot);
    const metrics = await measure(page);
    if (!metrics) throw new Error(`${name}: no player in the pane — refusing to write`);
    const out = await makeSnap(OUT_DIR)(shell, `${name}.png`);
    writeFileSync(
      path.join(OUT_DIR, `${name}.json`),
      JSON.stringify({ shot, metrics }, null, 2) + "\n"
    );
    return out;
  } finally {
    await context.close();
  }
}

test("audio player — narrow pane widths, scroll positions, scrollbars", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_AUDIOPLAYER is required for the audio player capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_AUDIOPLAYER=1 to run the capture");

  const written: string[] = [];
  for (const shot of SHOTS) written.push(await capture(shot));

  const expected = SHOTS.map((s) => `${shotName(s)}.png`);
  const onDisk = existsSync(OUT_DIR) ? readdirSync(OUT_DIR) : [];
  const missing = expected.filter((f) => !onDisk.includes(f));
  writeFileSync(
    path.join(OUT_DIR, "manifest.json"),
    JSON.stringify({ expected: expected.length, missing, written }, null, 2) + "\n"
  );
  expect(missing, "every promised capture is on disk").toEqual([]);
});
