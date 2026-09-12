/**
 * Theme browser (theme picker) visual-review harness.
 *
 * Captures the every state of the theme browser drawer that carries design
 * weight, so the surface can be judged against real rendered pixels rather
 * than token values. Sibling of theme-review.spec.ts, which shoots the
 * workbench under a theme; this one shoots the picker itself.
 *
 * The states matter more than the count. Three of them are only reachable by
 * driving the surface and are exactly where its defects live:
 *   - preview-active: a previewed row that is NOT the committed one, which is
 *     the only state that shows whether committed and previewed are legible as
 *     different things.
 *   - scrim-hover: the pointer parked over the dimmed app behind the panel —
 *     the non-interactive cue the whole scrim exists to deliver.
 *   - short-window: the panel at a laptop viewport, where the list fills and
 *     scrolls instead of stranding empty canvas.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_THEMEBROWSER is set, so the
 * marketing screenshots project never runs it.
 *
 *   DAINTREE_SHOT_THEMEBROWSER=1 npx playwright test --project=screenshots theme-browser-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_THEMEBROWSER  required — any non-empty value
 *   DAINTREE_SHOT_DIR    output dir (default artifacts/theme-browser-shots)
 *   DAINTREE_SHOT_TAG    optional suffix to keep rounds side by side
 *   DAINTREE_SHOT_THEMES comma-separated theme ids (default "daintree,bondi")
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 2)
 *
 * Output: <dir>/<theme>/<NN-slug>[-tag].png (gitignored).
 */

import { test, expect, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = Boolean(process.env.DAINTREE_SHOT_THEMEBROWSER);
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const ROOT_DIR = path.resolve(
  process.cwd(),
  process.env.DAINTREE_SHOT_DIR ?? path.join("artifacts", "theme-browser-shots")
);

/** Every slug this spec must produce, per theme. Checked after the run. */
const EXPECTED_SLUGS = [
  "10-open-dark",
  "11-open-light",
  "12-filtered",
  "13-empty",
  "14-preview-active",
  "15-keyboard-focus",
  "16-scrim-hover",
  "17-short-window",
] as const;

// Freeze animations and hide carets so captures are deterministic.
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

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

/** Small repo with enough content that the app behind the scrim is worth looking at. */
function createRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-tbshots-"));
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(
    path.join(dir, "src", "index.ts"),
    'export function main(): number {\n  const greeting = "hello";\n  console.log(greeting);\n  return 0;\n}\n'
  );
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  writeFileSync(path.join(dir, "notes.md"), "# Notes\n\n- theme browser review pass\n");
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function settle(page: Page, ms = 600): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/**
 * Screenshot after a settle. Deliberately NOT wrapped in try/catch: a step that
 * cannot reach its state must fail the run, not quietly leave a slug missing.
 * Silent per-step recovery is how a capture harness reports success while
 * producing nothing.
 */
async function snap(page: Page, outDir: string, slug: string, locator?: string): Promise<void> {
  await settle(page);
  const file = path.join(outDir, `${slug}${TAG}.png`);
  if (locator) {
    await page.locator(locator).first().screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }
}

/** Open the browser through the same action the command palette dispatches. */
async function openThemeBrowser(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("daintree:open-theme-browser"));
  });
  await page
    .locator(SEL.settings.themeBrowserDialog)
    .waitFor({ state: "visible", timeout: T_LONG });
  await settle(page, 500);
}

async function closeThemeBrowser(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page
    .locator(SEL.settings.themeBrowserDialog)
    .waitFor({ state: "hidden", timeout: T_LONG })
    .catch(() => {});
  await settle(page, 300);
}

test.describe("theme browser shots", () => {
  test.setTimeout(10 * 60 * 1000);

  for (const theme of THEMES) {
    test(`theme browser states — ${theme}`, async () => {
      test.info().annotations.push({
        type: "conditional-skip",
        description: "DAINTREE_SHOT_THEMEBROWSER is required for the theme-browser capture",
      });
      test.skip(!ENABLED, "Set DAINTREE_SHOT_THEMEBROWSER=1 to run the theme-browser capture");

      const outDir = path.join(ROOT_DIR, theme);
      mkdirSync(outDir, { recursive: true });
      const repo = createRepo();
      const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-tbshot-"));
      let ctx: AppContext | undefined;

      try {
        ctx = await launchApp({
          userDataDir,
          screenshotScale: SCALE,
          windowSize: { width: 1680, height: 1050 },
          extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
        });
        const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
        await setAppTheme(page, theme);
        await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
        await dismissBlockingPalette(page);
        await settle(page, 1500);
        await dismissBlockingPalette(page);

        const list = page.locator(SEL.settings.themeListbox);
        const search = page.locator('[aria-label="Filter themes"]');

        // 10. At rest, Dark filter — the default landing state.
        await openThemeBrowser(page);
        await snap(page, outDir, "10-open-dark");

        // 11. Light filter — half the catalogue, and the mode that flips the
        //     whole app's luminance on commit.
        await page.locator('button:text-is("Light")').click();
        await settle(page, 500);
        await snap(page, outDir, "11-open-light");
        await page.locator('button:text-is("Dark")').click();
        await settle(page, 400);

        // 12. Filtered to a short list — the row layout with the list not full.
        await search.click();
        await search.fill("a");
        await settle(page, 500);
        await snap(page, outDir, "12-filtered");

        // 13. Empty result — the state nobody looks at.
        await search.fill("zzzz");
        await settle(page, 500);
        await snap(page, outDir, "13-empty");
        await search.fill("");
        await settle(page, 400);

        // 14. Previewing a row that is NOT the committed one. This is the
        //     state that shows whether "what I run" and "what I'm trying" are
        //     distinguishable — capture the whole window, because the live
        //     preview repaints the app behind the panel too.
        const notCommitted = list.locator('[role="option"]:not([aria-current="true"])');
        await notCommitted.first().click();
        await settle(page, 700);
        // The point of this frame is committed != previewed. If they coincide
        // the shot proves nothing, so fail rather than capture a useless state.
        const committedName = await list
          .locator('[role="option"][aria-current="true"]')
          .first()
          .innerText();
        const previewedName = await list
          .locator('[role="option"][aria-selected="true"]')
          .first()
          .innerText();
        expect(
          previewedName,
          "preview-active shot needs a preview distinct from the committed theme"
        ).not.toBe(committedName);
        await snap(page, outDir, "14-preview-active");

        // 15. Keyboard focus ring on an arrowed row.
        await search.click();
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await settle(page, 600);
        await snap(page, outDir, "15-keyboard-focus");

        // 16. Pointer parked over the dimmed app behind the panel. The scrim
        //     owns the "you can't click here" cue; this is the only frame that
        //     shows whether it lands. Park well clear of the 380px panel.
        await page.mouse.move(400, 500);
        await settle(page, 700);
        await snap(page, outDir, "16-scrim-hover");

        // 17. Laptop-height window: the list should fill and scroll rather
        //     than stranding empty canvas under the last row.
        await closeThemeBrowser(page);
        await page.evaluate(() => window.resizeTo(1280, 720)).catch(() => {});
        await settle(page, 600);
        await openThemeBrowser(page);
        await snap(page, outDir, "17-short-window");

        // Verify AFTER the run, from the filesystem — never trust the exit code.
        const written = new Set(
          readdirSync(outDir)
            .filter((f) => f.endsWith(".png"))
            .map((f) => f.replace(`${TAG}.png`, "").replace(".png", ""))
        );
        const missing = EXPECTED_SLUGS.filter((slug) => !written.has(slug));
        expect(missing, `capture states missing from ${outDir}`).toEqual([]);
        expect(written.size, `expected ${EXPECTED_SLUGS.length} PNGs in ${outDir}`).toBe(
          EXPECTED_SLUGS.length
        );
      } finally {
        if (ctx?.app) await closeApp(ctx.app);
        repo.cleanup();
        rmSync(userDataDir, { recursive: true, force: true });
      }
    });
  }
});
