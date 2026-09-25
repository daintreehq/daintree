/**
 * Project Pulse heatmap + streak flame visual-review harness.
 *
 * Drives the pulse surface on the canvas home — the collapsed strip (mini
 * ribbon + streak flame) and the expanded card (heatmap grid, legend, summary
 * row with the flame) — through every state that carries design weight, and
 * writes a PNG of each.
 *
 * The data goes through the real seam: the pulse service runs `git log` over
 * HEAD, so each phase swaps `main` onto a pre-built history (fast-imported as
 * separately-rooted orphan branches, because the service dates the project
 * from HEAD's root commit). A reload resets the renderer store and the new
 * HEAD sha defeats the service cache, so the next render is a real rescan.
 *
 *   young       — first commit 4 days ago, 5-day streak (tier 1)
 *   established — 200 days of weekday-ish history with gaps, 17-day streak
 *   marathon    — every day for 250 days, top streak tier
 *
 * Opt-in only: skips itself unless DESIGN_CAPTURE_DIR is set. That directory
 * is also the output — there is deliberately no in-repo default.
 *
 *   DESIGN_CAPTURE_DIR=/abs/out npx playwright test --project=screenshots pulse-heatmap-review
 *
 * Env knobs:
 *   DESIGN_CAPTURE_DIR          required — absolute output directory
 *   DAINTREE_SHOT_ANCHORS       themes that get every state (default daintree,bondi)
 *   DAINTREE_SHOT_SWEEP         themes that get the established card only
 *                               (default: every other built-in theme; "none" to skip)
 *   DAINTREE_SCREENSHOT_SCALE   device scale factor (default 2)
 *
 * Output: <dir>/pulse--<state>--<theme>.png
 */

import { expect, test, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { createHash } from "crypto";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const OUT = process.env.DESIGN_CAPTURE_DIR ?? "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";

const ALL_THEMES = [
  "daintree",
  "bondi",
  "arashiyama",
  "atacama",
  "bali",
  "fiordland",
  "galapagos",
  "highlands",
  "hokkaido",
  "namib",
  "redwoods",
  "serengeti",
  "svalbard",
  "table-mountain",
  "movile",
];

function themeList(value: string | undefined, fallback: string[]): string[] {
  if (value === "none") return [];
  const list = (value ?? "").split(",").filter(Boolean);
  return list.length > 0 ? list : fallback;
}

const ANCHORS = themeList(process.env.DAINTREE_SHOT_ANCHORS, ["daintree", "bondi"]);
const SWEEP = themeList(
  process.env.DAINTREE_SHOT_SWEEP,
  ALL_THEMES.filter((t) => !ANCHORS.includes(t))
);

const STRIP = 'button[aria-label^="Project pulse"]';
const CARD = ".pulse-card";
const GRID = '[data-testid="pulse-heatmap"]';
const WIDE = { width: 1680, height: 1050 };

const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

const DAY_MS = 86_400_000;

/** Local noon `daysAgo` days back — today's commit is pinned a few minutes ago. */
function stampFor(daysAgo: number): number {
  if (daysAgo === 0) return Math.floor((Date.now() - 5 * 60_000) / 1000);
  const d = new Date(Date.now() - daysAgo * DAY_MS);
  d.setHours(12, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

// Deterministic, uneven per-day volumes so the p90 scaling spreads cells over
// all four heat levels instead of flattening them. The length is prime so the
// pattern never lines up with a week (or any other grid period) and paints
// stripes that look like a layout artefact.
const VOLUMES = [2, 1, 3, 6, 1, 2, 9, 1, 4, 2, 1, 5, 3, 1, 12, 2, 1, 3, 7];

type History = { branch: string; days: Array<{ daysAgo: number; count: number }> };

function youngHistory(): History {
  return {
    branch: "hist-young",
    days: [4, 3, 2, 1, 0].map((d, i) => ({ daysAgo: d, count: VOLUMES[i]! })),
  };
}

function establishedHistory(): History {
  const days: History["days"] = [];
  for (let d = 199; d >= 0; d -= 1) {
    const inStreak = d <= 16;
    const weekend = d % 7 === 5 || d % 7 === 6;
    const vacation = d >= 60 && d <= 68;
    const early = d >= 150;
    const active = inStreak || (d !== 17 && !weekend && !vacation && (!early || d % 3 === 0));
    if (active) days.push({ daysAgo: d, count: VOLUMES[d % VOLUMES.length]! });
  }
  return { branch: "hist-established", days };
}

function marathonHistory(): History {
  const days: History["days"] = [];
  for (let d = 249; d >= 0; d -= 1) days.push({ daysAgo: d, count: VOLUMES[d % VOLUMES.length]! });
  return { branch: "hist-marathon", days };
}

/** One `git fast-import` stream per history — hundreds of commits in one process. */
function importHistory(dir: string, history: History): void {
  const lines: string[] = [];
  let mark = 0;
  history.days.forEach(({ daysAgo, count }, dayIndex) => {
    for (let n = 0; n < count; n += 1) {
      mark += 1;
      const when = stampFor(daysAgo) + n * 60;
      const msg = `feat: change ${mark}`;
      lines.push(`commit refs/heads/${history.branch}`);
      lines.push(`mark :${mark}`);
      lines.push(`author Daintree Test <test@daintree.dev> ${when} +0000`);
      lines.push(`committer Daintree Test <test@daintree.dev> ${when} +0000`);
      lines.push(`data ${Buffer.byteLength(msg)}`);
      lines.push(msg);
      if (dayIndex === 0 && n === 0) {
        const readme = "# Helios Dashboard\n";
        lines.push(`M 644 inline README.md`);
        lines.push(`data ${Buffer.byteLength(readme)}`);
        lines.push(readme);
      }
      lines.push("");
    }
  });
  execSync("git fast-import --quiet", {
    cwd: dir,
    input: lines.join("\n") + "\n",
    stdio: ["pipe", "ignore", "inherit"],
  });
}

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-pulse-shots-"));
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  for (const history of [youngHistory(), establishedHistory(), marathonHistory()]) {
    importHistory(dir, history);
  }
  git("reset --hard hist-young", dir);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function useHistory(dir: string, branch: string): void {
  git(`reset --hard ${branch}`, dir);
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function polish(page: Page): Promise<void> {
  await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
  await dismissBlockingPalette(page);
}

/** Wait until the collapsed strip shows the streak this phase seeded. */
async function waitForStrip(page: Page, streak: number): Promise<void> {
  const strip = page.locator(STRIP);
  await strip.waitFor({ state: "visible", timeout: T_LONG });
  await expect
    .poll(() => strip.getAttribute("aria-label"), {
      timeout: 30_000,
      message: `strip never showed a ${streak} day streak`,
    })
    .toContain(`${streak} day streak`);
  await settle(page, 500);
}

async function reloadTo(page: Page, streak: number): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(SEL.toolbar.toggleSidebar).waitFor({ state: "visible", timeout: T_LONG });
  await polish(page);
  await waitForStrip(page, streak);
}

async function applyTheme(page: Page, theme: string, streak: number): Promise<void> {
  await setAppTheme(page, theme);
  await polish(page);
  await waitForStrip(page, streak);
}

type Range = "60d" | "120d" | "180d";

async function setRange(page: Page, range: Range): Promise<void> {
  await page.locator(`${CARD} [role="radio"]:has-text("${range}")`).click();
  await expect
    .poll(() => page.locator(`${CARD} [role="radio"][aria-checked="true"]`).innerText())
    .toContain(range);
  await expect
    .poll(() => page.locator(`${CARD}[aria-busy="true"]`).count(), { timeout: 20_000 })
    .toBe(0);
  await settle(page, 700);
}

/** Expand the strip into the card and optionally pick a range. */
async function openCard(page: Page, range?: Range): Promise<void> {
  await page.locator(STRIP).click({ timeout: 8000 });
  await page.locator(GRID).waitFor({ state: "visible", timeout: T_LONG });
  if (range) await setRange(page, range);
  await expect
    .poll(() => page.locator(`${CARD}[aria-busy="true"]`).count(), { timeout: 20_000 })
    .toBe(0);
  await settle(page, 700);
}

async function collapseCard(page: Page): Promise<void> {
  await page.locator('button:has-text("Collapse")').click({ timeout: 5000 });
  await page.locator(STRIP).waitFor({ state: "visible", timeout: 5000 });
  await settle(page, 300);
}

async function cellCount(page: Page): Promise<number> {
  return page.locator(`${GRID} [role="gridcell"]`).count();
}

/**
 * The card opens below the strip inside the canvas scroller; a viewport clip
 * taken before scrolling photographs half a card. Only scroll when the element
 * is not already whole on screen — any scroll closes an open tooltip, so the
 * focus and hover states reveal first and interact second.
 */
async function revealWhole(page: Page, selector: string): Promise<void> {
  await page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) {
        el.scrollIntoView({ block: "center", inline: "nearest" });
      }
    });
  await settle(page, 200);
}

const written: string[] = [];

async function snap(
  page: Page,
  selector: string,
  state: string,
  theme: string,
  pad = { top: 16, right: 16, bottom: 16, left: 16 },
  hoverTarget?: string
): Promise<void> {
  // Park the pointer for every state that is not about hover. "Collapse"
  // sits exactly where the strip re-renders, so after collapsing the pointer
  // is already over the strip and its rest capture would quietly be a hover.
  if (!state.includes("hover")) await page.mouse.move(2, 2);
  await revealWhole(page, selector);
  await settle(page);
  // Hover is re-asserted at the last moment: another window taking OS focus
  // during the settle sends Chromium a mouse-leave, and the capture silently
  // becomes the rest state.
  if (hoverTarget) {
    await page.locator(hoverTarget).first().hover();
    await settle(page, 150);
  }
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no bounding box for ${selector}`);
  const viewport = page.viewportSize() ?? WIDE;
  const x = Math.max(0, box.x - pad.left);
  const y = Math.max(0, box.y - pad.top);
  const width = Math.min(viewport.width - x, box.width + pad.left + pad.right);
  const height = Math.min(viewport.height - y, box.height + pad.top + pad.bottom);
  if (box.y < 0 || box.y + box.height > viewport.height) {
    throw new Error(`${selector} does not fit the viewport (${Math.round(box.height)}px tall)`);
  }
  const file = path.join(OUT, `pulse--${state}--${theme}.png`);
  await page.screenshot({
    path: file,
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: { x, y, width, height },
  });
  if (!existsSync(file)) throw new Error(`screenshot did not land at ${file}`);
  written.push(path.basename(file));
}

const TOOLTIP_PAD = { top: 56, right: 16, bottom: 16, left: 16 };
const failures: string[] = [];

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const detail = String(error).split("\n")[0];
    console.warn(`[pulse-shots] step "${name}" FAILED:`, detail);
    failures.push(`${name}: ${detail}`);
  }
}

test("pulse heatmap review — heatmap and streak flame across states and themes", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DESIGN_CAPTURE_DIR is required for the pulse-heatmap-review capture",
  });
  test.skip(!OUT, "Set DESIGN_CAPTURE_DIR to run the pulse-heatmap-review capture");
  if (!path.isAbsolute(OUT)) throw new Error("DESIGN_CAPTURE_DIR must be an absolute path");
  test.setTimeout(1_500_000);

  mkdirSync(OUT, { recursive: true });
  const repo = createRepo();
  // Prefix avoids "daintree-e2e" — launchApp's pre-launch hygiene pkills it.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-pulseshot-"));
  const expected: string[] = [];

  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: WIDE,
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await page.evaluate(async () => {
      const cur = await window.electron.project.getCurrent();
      if (cur?.id) await window.electron.project.update(cur.id, { name: "Helios Dashboard" });
    });
    await polish(page);

    // Phase 1 — a four-day-old repo. The heatmap has only five real days to
    // draw, which is where row alignment and a sparse legend show.
    for (const theme of ANCHORS) {
      await applyTheme(page, theme, 5);
      expected.push(`pulse--young-strip--${theme}.png`, `pulse--young-card--${theme}.png`);
      await step(`young-strip ${theme}`, () => snap(page, STRIP, "young-strip", theme));
      await step(`young-card ${theme}`, async () => {
        await openCard(page);
        const cells = await cellCount(page);
        if (cells < 1 || cells > 6) throw new Error(`young grid rendered ${cells} cells`);
        await snap(page, CARD, "young-card", theme);
        await collapseCard(page);
      });
    }

    // Phase 2 — an established repo: the everyday state.
    useHistory(repo.dir, "hist-established");
    await reloadTo(page, 17);
    for (const theme of ANCHORS) {
      await applyTheme(page, theme, 17);
      const states = [
        "strip",
        "card-60",
        "card-180",
        "cell-focus",
        "cell-hover",
        "forced-colors",
        "contrast-more",
      ];
      expected.push(...states.map((s) => `pulse--${s}--${theme}.png`));

      await step(`strip ${theme}`, () => snap(page, STRIP, "strip", theme));

      await step(`strip-hover ${theme}`, async () => {
        expected.push(`pulse--strip-hover--${theme}.png`);
        // Reveal before hovering: a scroll after the hover moves the strip
        // out from under the pointer and the capture is the rest state again.
        await revealWhole(page, STRIP);
        const rest = await page
          .locator(STRIP)
          .evaluate((el) => getComputedStyle(el).backgroundColor);
        await page.locator(STRIP).hover();
        await expect
          .poll(
            () =>
              page.locator(STRIP).evaluate(
                (el, restBg) => ({
                  hovered: el.matches(":hover"),
                  filled: getComputedStyle(el).backgroundColor !== restBg,
                }),
                rest
              ),
            { timeout: 3000, message: "strip never took its hover state" }
          )
          .toEqual({ hovered: true, filled: true });
        await settle(page, 300);
        await snap(page, STRIP, "strip-hover", theme, undefined, STRIP);
        await page.mouse.move(2, 2);
      });

      await step(`card-60 ${theme}`, async () => {
        await openCard(page, "60d");
        const cells = await cellCount(page);
        if (cells !== 60) throw new Error(`60d grid rendered ${cells} cells`);
        await snap(page, CARD, "card-60", theme);
      });

      await step(`card-180 ${theme}`, async () => {
        await setRange(page, "180d");
        const cells = await cellCount(page);
        if (cells !== 180) throw new Error(`180d grid rendered ${cells} cells`);
        await snap(page, CARD, "card-180", theme);
      });

      // Keyboard entry into the grid: tabbed, never `.focus()`, so Chromium
      // sets :focus-visible and the focus tooltip opens as a user sees it.
      await step(`cell-focus ${theme}`, async () => {
        await revealWhole(page, CARD);
        await page.locator(`${CARD} .pulse-card-header span.text-sm`).click();
        let reached = false;
        for (let press = 0; press < 12 && !reached; press += 1) {
          await page.keyboard.press("Tab");
          reached = await page.evaluate(
            () => document.activeElement?.getAttribute("role") === "gridcell"
          );
        }
        if (!reached) throw new Error("Tab never reached a heatmap cell");
        await page.keyboard.press("ArrowLeft");
        await page.keyboard.press("ArrowLeft");
        // The focused trigger must report its tooltip open at capture time —
        // an attached-but-closed tooltip node proves nothing.
        await expect
          .poll(
            () => page.evaluate(() => document.activeElement?.getAttribute("data-state") ?? ""),
            { timeout: 3000 }
          )
          .toMatch(/open$/);
        await page
          .locator("[data-radix-popper-content-wrapper]")
          .first()
          .waitFor({ state: "visible", timeout: 3000 });
        // Held past the app's 2.5s hint window: a day's tooltip is its only
        // visible readout, so it has to still be there when a user reads it.
        await page.waitForTimeout(3000);
        await page
          .locator("[data-radix-popper-content-wrapper]")
          .first()
          .waitFor({ state: "visible", timeout: 500 });
        await snap(page, CARD, "cell-focus", theme, TOOLTIP_PAD);
        await page.keyboard.press("Escape");
      });

      await step(`cell-hover ${theme}`, async () => {
        await revealWhole(page, CARD);
        const target = page.locator(`${GRID} [role="gridcell"][data-heat-level="4"]`).nth(1);
        await target.hover();
        await page
          .locator("[data-radix-popper-content-wrapper]")
          .first()
          .waitFor({ state: "visible", timeout: 3000 });
        await snap(page, CARD, "cell-hover", theme, TOOLTIP_PAD);
        await page.mouse.move(2, 2);
        await settle(page, 200);
      });

      await step(`forced-colors ${theme}`, async () => {
        await page.emulateMedia({ forcedColors: "active" });
        await settle(page, 500);
        await snap(page, CARD, "forced-colors", theme);
        await page.emulateMedia({ forcedColors: "none" });
      });

      await step(`contrast-more ${theme}`, async () => {
        await page.emulateMedia({ contrast: "more" });
        await settle(page, 500);
        await snap(page, CARD, "contrast-more", theme);
        await page.emulateMedia({ contrast: "no-preference" });
        await collapseCard(page);
      });
    }

    // The theme sweep: every other built-in theme, established card at 180d
    // (every heat level and the flame in one frame) plus the strip.
    for (const theme of SWEEP) {
      expected.push(`pulse--strip--${theme}.png`, `pulse--card-180--${theme}.png`);
      await step(`sweep ${theme}`, async () => {
        await applyTheme(page, theme, 17);
        await snap(page, STRIP, "strip", theme);
        await openCard(page, "180d");
        await snap(page, CARD, "card-180", theme);
        await collapseCard(page);
      });
    }

    // Phase 3 — an unbroken 250-day run: the top streak tier.
    useHistory(repo.dir, "hist-marathon");
    await reloadTo(page, 250);
    for (const theme of ANCHORS) {
      await applyTheme(page, theme, 250);
      expected.push(`pulse--marathon-strip--${theme}.png`, `pulse--marathon-card--${theme}.png`);
      await step(`marathon-strip ${theme}`, () => snap(page, STRIP, "marathon-strip", theme));
      await step(`marathon-card ${theme}`, async () => {
        await openCard(page, "180d");
        await snap(page, CARD, "marathon-card", theme);
        await collapseCard(page);
      });
    }

    const present = new Set(readdirSync(OUT));
    const missing = expected.filter((f) => !present.has(f));
    // Two same-theme states that render byte-identically mean one of them
    // never happened. Cross-theme pairs are excluded: forced-colors discards
    // the theme, so its captures legitimately match across themes.
    const byHash = new Map<string, string[]>();
    for (const file of written) {
      const theme = file.replace(/\.png$/, "").split("--")[2];
      const hash = createHash("sha256")
        .update(readFileSync(path.join(OUT, file)))
        .digest("hex");
      const key = `${theme}:${hash}`;
      byHash.set(key, [...(byHash.get(key) ?? []), file]);
    }
    const duplicates = [...byHash.values()].filter((files) => files.length > 1);

    expect(failures, "pulse capture steps failed").toEqual([]);
    expect(missing, `pulse captures missing from ${OUT}`).toEqual([]);
    expect(duplicates, "identical pulse captures — a step drove nothing").toEqual([]);
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
