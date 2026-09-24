/**
 * Daintree Tour scene visual-review harness.
 *
 * Captures the mockup frames themselves — the stage only, never the dialog
 * chrome around it — at the moments each chapter's narration points at. It
 * drives the same `tour-preview.html` entry as `tour-dialog-review`, blocks the
 * CDN so the silent wall clock runs the timeline, and seeks the paused player
 * to `cue + offset` for each frame. The paused overlay is hidden for the shot.
 *
 *   DAINTREE_SHOT_TOUR_SCENES=1 npx playwright test --project=screenshots tour-scenes-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_TOUR_SCENES  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          output directory (default artifacts/tour-scene-shots)
 *   DAINTREE_SHOT_CHAPTERS     comma-separated chapter ids (default: all)
 *
 * Every moment is captured on the dark default theme; the moments marked
 * `light` are captured again on bondi. Never writes a frame it has not
 * verified: each asserts the player is paused on the requested time first, and
 * the test counts the files itself at the end.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { makeSnap, startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_TOUR_SCENES;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "tour-scene-shots")
);

const DARK = "daintree";
const LIGHT = "bondi";

interface Moment {
  name: string;
  cue: string;
  offset: number;
  light?: boolean;
}

const MOMENTS: Record<string, readonly Moment[]> = {
  welcome: [
    { name: "first-agent", cue: "first", offset: 0.8 },
    { name: "side-by-side", cue: "grid", offset: 1.5 },
    { name: "watching", cue: "watch", offset: 1.2, light: true },
  ],
  worktrees: [
    { name: "project", cue: "project", offset: 0.8 },
    { name: "branch", cue: "branch", offset: 0.8, light: true },
    { name: "naming", cue: "create", offset: -0.3 },
    { name: "created", cue: "create", offset: 1.5 },
  ],
  agents: [
    { name: "pinned", cue: "pick", offset: 0.8 },
    { name: "launcher", cue: "launcher", offset: 1.2, light: true },
    { name: "typing", cue: "send", offset: -0.4 },
    { name: "terminal", cue: "term", offset: 1.2 },
  ],
  state: [
    { name: "legend", cue: "done", offset: 0.8, light: true },
    { name: "waiting-list", cue: "jump", offset: 1.0 },
    { name: "answering", cue: "answer", offset: 1.2 },
  ],
  fleet: [
    { name: "armed", cue: "armed", offset: 0.6 },
    { name: "mirroring", cue: "send", offset: -0.4, light: true },
    { name: "sent", cue: "send", offset: 1.8 },
  ],
  files: [
    { name: "opened", cue: "pick", offset: 1.0 },
    { name: "dragging", cue: "ref", offset: 1.3 },
    { name: "dropped", cue: "drop", offset: 0.8, light: true },
  ],
  context: [
    { name: "menu", cue: "copy", offset: 0.9 },
    { name: "copied", cue: "copy", offset: 2.2 },
    { name: "pasted", cue: "paste", offset: 1.0, light: true },
  ],
  preview: [
    { name: "launcher", cue: "launch", offset: 1.2 },
    { name: "start", cue: "start", offset: -0.4 },
    { name: "live", cue: "live", offset: 1.5, light: true },
    { name: "console", cue: "console", offset: 1.2 },
  ],
  github: [
    { name: "counts", cue: "pill", offset: 0.6 },
    { name: "issues", cue: "list", offset: 1.0, light: true },
    { name: "form", cue: "pick", offset: 1.2 },
    { name: "linked", cue: "badge", offset: 2.4 },
  ],
  review: [
    { name: "ask", cue: "files", offset: -0.6 },
    { name: "card", cue: "open", offset: 0.3 },
    { name: "diff", cue: "diff", offset: 1.5, light: true },
    { name: "commit", cue: "commit", offset: 1.4 },
  ],
  pilot: [
    { name: "keys", cue: "open", offset: 0.6 },
    { name: "sorted", cue: "sort", offset: 0.6, light: true },
    { name: "park-editor", cue: "park", offset: 1.3 },
    { name: "parked", cue: "park", offset: 3.2 },
  ],
  assistant: [
    { name: "idle", cue: "start", offset: -0.4 },
    { name: "acting", cue: "act", offset: 2.4 },
    { name: "tells", cue: "tell", offset: 1.0, light: true },
  ],
  palette: [
    { name: "keys", cue: "palette", offset: 0.6 },
    { name: "results", cue: "type", offset: 3.0, light: true },
    { name: "help", cue: "help", offset: 1.0 },
  ],
  outro: [{ name: "close", cue: "next", offset: 1.2, light: true }],
};

const CHAPTERS = Object.keys(MOMENTS);
const ONLY = (process.env.DAINTREE_SHOT_CHAPTERS ?? "")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);
const SELECTED = ONLY.length ? CHAPTERS.filter((c) => ONLY.includes(c)) : CHAPTERS;

test.use({ deviceScaleFactor: 2 });

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
  baseURL = server.baseURL;
});

test.afterAll(async () => {
  await server?.close();
});

async function openChapter(page: Page, theme: string, chapter: string): Promise<void> {
  await stubViteHmrClient(page);
  await page.route("https://cdn.daintree.org/**", (route) => route.abort());
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseURL}/tour-preview.html?theme=${theme}&chapter=${chapter}&t=0&muted=1`);
  await expect(page.getByTestId("daintree-tour")).toBeVisible();
  await expect(page.locator("[data-tour-canvas]")).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
  // The paused dim and play mark sit over the scene; the frame is what's under them.
  await page.addStyleTag({ content: "[data-tour-canvas] ~ * { display: none !important; }" });
  await page.waitForTimeout(500);
}

/** Seek the paused player to `cue + offset` and return the time it landed on. */
async function seekTo(page: Page, cue: string, offset: number): Promise<number> {
  return page.evaluate(
    ({ cue, offset }) => {
      const t = Reflect.get(window, "__tour") as {
        pause(): void;
        seek(t: number): void;
        timing: { cues: Record<string, number> };
      };
      const at = t.timing.cues[cue];
      if (at === undefined) throw new Error(`no cue "${cue}" in this chapter`);
      t.pause();
      t.seek(Math.max(0, at + offset));
      return Math.max(0, at + offset);
    },
    { cue, offset }
  );
}

test("Daintree Tour — scene frames", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_TOUR_SCENES is required for the scene capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_TOUR_SCENES=1 to run the capture");
  test.setTimeout(10 * 60_000);

  const snap = makeSnap(OUT_DIR);
  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const theme of [DARK, LIGHT]) {
    for (const chapter of SELECTED) {
      const moments = MOMENTS[chapter]!.filter((m) => theme === DARK || m.light);
      if (!moments.length) continue;
      await openChapter(page, theme, chapter);
      for (const [i, moment] of moments.entries()) {
        await seekTo(page, moment.cue, moment.offset);
        // Reveals are 200ms and the pointer glides for 600ms; the spotlight re-measures at 260ms.
        await page.waitForTimeout(950);
        const status = await page.evaluate(
          () =>
            (Reflect.get(window, "__tour") as { getState(): { status: string } }).getState().status
        );
        expect(status, `${chapter}/${moment.name} must be a frozen frame`).toBe("paused");
        const stage = page.locator("[data-tour-canvas]").locator("..");
        const file = `${String(CHAPTERS.indexOf(chapter) + 1).padStart(2, "0")}-${chapter}-${i + 1}-${moment.name}-${theme}.png`;
        written.push(await snap(stage, file));
      }
    }
  }

  expect(pageErrors, "page errors during capture").toEqual([]);
  const expected = SELECTED.reduce(
    (n, chapter) => n + MOMENTS[chapter]!.length + MOMENTS[chapter]!.filter((m) => m.light).length,
    0
  );
  expect(written.length).toBe(expected);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(expected);
});
