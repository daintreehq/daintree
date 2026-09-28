/**
 * Settings subject picker visual-review harness.
 *
 * The control at the top of Settings → CLI agents, Settings → Code forge and a
 * project's Plugins page chooses what the rest of the page is about. Its design
 * questions live in states that only exist mid-interaction — the list open over
 * the page, the pointer on a row, the keyboard cursor, a filter, no matches, and
 * the frames of the opening motion — so this drives the real components through
 * `settings-subject-picker-preview.html` rather than booting Electron.
 *
 *   DAINTREE_SHOT_SUBJECTPICKER=1 DAINTREE_SHOT_DIR=/abs/out \
 *     ./node_modules/.bin/playwright test --project=screenshots settings-subject-picker-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SUBJECTPICKER  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR            required — absolute output directory outside the repo
 *   DAINTREE_SHOT_THEMES         full sweep themes (default: daintree)
 *   DAINTREE_SHOT_SPOT_THEMES    themes for the spot states (default: bondi)
 *
 * Never writes a PNG it has not verified: every state asserts its own marker
 * before capture, and the run counts the files on disk against the plan.
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_SUBJECTPICKER;
const OUT_DIR = path.resolve(process.env.DAINTREE_SHOT_DIR ?? "");

const parseList = (value: string | undefined, fallback: string) =>
  (value ?? fallback)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
const THEMES = parseList(process.env.DAINTREE_SHOT_THEMES, "daintree");
const SPOT_THEMES = parseList(process.env.DAINTREE_SHOT_SPOT_THEMES, "bondi");

interface PageSpec {
  page: "agents" | "forge" | "plugins";
  subject: string;
  /** A row name to hover, and a filter query that matches some rows. */
  hoverRow: string;
  query: string;
}

const PAGES: PageSpec[] = [
  { page: "agents", subject: "codex", hoverRow: "Gemini", query: "co" },
  { page: "plugins", subject: "project:lifeplan", hoverRow: "Docker Control", query: "git" },
  { page: "forge", subject: "daintree.github.github", hoverRow: "GitLab", query: "lab" },
];

test.use({ deviceScaleFactor: 2, viewport: { width: 735, height: 760 } });

let server: ViteDevServer | undefined;
let baseURL = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!process.env.DAINTREE_SHOT_DIR || !path.isAbsolute(OUT_DIR)) {
    throw new Error("DAINTREE_SHOT_DIR must be an absolute directory outside the repo");
  }
  const repoRoot = realpathSync(process.cwd());
  mkdirSync(OUT_DIR, { recursive: true });
  const outReal = realpathSync(OUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DAINTREE_SHOT_DIR must be outside the repo (${OUT_DIR})`);
  }
  for (const file of readdirSync(OUT_DIR)) {
    if (file.endsWith(".png")) rmSync(path.join(OUT_DIR, file), { force: true });
  }
  // A worktree symlinks node_modules out of the project root, and Vite refuses
  // to serve the bundled fonts through it unless the real path is allowed.
  server = await createServer({
    server: {
      port: 0,
      strictPort: false,
      fs: { allow: [process.cwd(), realpathSync(path.join(process.cwd(), "node_modules"))] },
    },
    logLevel: "error",
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("vite gave no TCP address");
  baseURL = `http://127.0.0.1:${address.port}`;
  await server.warmupRequest("/src/components/Settings/__preview__/subjectPicker.tsx");
});

test.afterAll(async () => {
  await server?.close();
});

async function load(page: Page, spec: PageSpec, subject: string, theme: string): Promise<void> {
  const url = `${baseURL}/settings-subject-picker-preview.html?page=${spec.page}&subject=${subject}&theme=${theme}`;
  // Vite's optimizer can re-bundle after a page opens and force-reload it into a
  // blank document; one reload after a quiet wait gets past it.
  for (let attempt = 0; ; attempt++) {
    await page.goto(url);
    try {
      await expect(page.locator("[data-preview-frame]")).toBeAttached({ timeout: 10_000 });
      break;
    } catch (error) {
      if (attempt >= 2) throw error;
      await page.waitForTimeout(1500);
    }
  }
  await expect(trigger(page)).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1, 1);
}

const trigger = (page: Page) => page.locator("[data-preview-frame] button[aria-haspopup]").first();
const listbox = (page: Page) => page.getByRole("listbox");

async function openList(page: Page): Promise<void> {
  await trigger(page).click();
  await expect(listbox(page)).toBeVisible();
  // Past the 200ms entry so the frame is the list at rest, not mid-motion.
  await page.waitForTimeout(350);
}

async function shoot(page: Page, file: string, written: string[]): Promise<void> {
  const frame = await page.locator("[data-preview-frame]").boundingBox();
  if (!frame || frame.width < 100 || frame.height < 100) {
    throw new Error(`${file}: preview frame has no real box — refusing to write`);
  }
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, animations: "allow" });
  written.push(out);
}

/** Freezes the list's entry motion at `ms` so a frame of the reveal can be judged. */
async function shootOpening(page: Page, ms: number, file: string, written: string[]) {
  await page.addStyleTag({
    content: "[data-radix-popper-content-wrapper] > * { animation-play-state: paused !important; }",
  });
  await trigger(page).click();
  await expect(listbox(page)).toBeAttached();
  const paused = await page.evaluate((t) => {
    const content = document.querySelector("[data-radix-popper-content-wrapper] > *");
    if (!content) return 0;
    const animations = content.getAnimations();
    for (const a of animations) a.currentTime = t;
    return animations.length;
  }, ms);
  if (paused === 0) throw new Error(`${file}: the list has no entry animation to freeze`);
  await page.waitForTimeout(80);
  await shoot(page, file, written);
}

test("settings subject pickers — states, motion and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SUBJECTPICKER is required for the subject picker capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_SUBJECTPICKER=1 to run the capture");
  test.setTimeout(300_000);

  const written: string[] = [];
  let planned = 0;
  page.on("pageerror", (error) =>
    console.log(`[subject-picker-shots] pageerror: ${error.message}`)
  );
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log(`[subject-picker-shots] console: ${msg.text()}`);
  });

  // Warm every page once so the optimizer's discovery reloads happen here.
  for (const spec of PAGES) {
    await load(page, spec, spec.subject, THEMES[0]!);
    await openList(page);
    await page.keyboard.press("Escape");
  }

  for (const theme of THEMES) {
    for (const spec of PAGES) {
      const p = spec.page;
      await load(page, spec, "general", theme);
      await shoot(page, `${p}-closed-general-${theme}.png`, written);

      await load(page, spec, spec.subject, theme);
      await shoot(page, `${p}-closed-subject-${theme}.png`, written);

      await openList(page);
      await shoot(page, `${p}-open-${theme}.png`, written);

      await page
        .getByRole("option", { name: new RegExp(spec.hoverRow) })
        .first()
        .hover();
      await page.waitForTimeout(200);
      await shoot(page, `${p}-open-hover-${theme}.png`, written);

      await page.mouse.move(1, 1);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(200);
      await shoot(page, `${p}-open-keyboard-${theme}.png`, written);

      await page.keyboard.type(spec.query);
      await page.waitForTimeout(200);
      await shoot(page, `${p}-filter-${theme}.png`, written);

      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type("zzz");
      await expect(page.getByText(/match/i).first()).toBeVisible();
      await page.waitForTimeout(150);
      await shoot(page, `${p}-no-match-${theme}.png`, written);

      await load(page, spec, spec.subject, theme);
      await shootOpening(page, 50, `${p}-opening-50ms-${theme}.png`, written);
      await load(page, spec, spec.subject, theme);
      await shootOpening(page, 110, `${p}-opening-110ms-${theme}.png`, written);
      planned += 9;
    }
  }

  for (const theme of SPOT_THEMES) {
    for (const spec of PAGES) {
      const p = spec.page;
      await load(page, spec, spec.subject, theme);
      await shoot(page, `${p}-closed-subject-${theme}.png`, written);
      await openList(page);
      await page
        .getByRole("option", { name: new RegExp(spec.hoverRow) })
        .first()
        .hover();
      await page.waitForTimeout(200);
      await shoot(page, `${p}-open-hover-${theme}.png`, written);
      planned += 2;
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(written.length).toBe(planned);
  expect(onDisk.length).toBe(planned);
  console.log(`[subject-picker-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
