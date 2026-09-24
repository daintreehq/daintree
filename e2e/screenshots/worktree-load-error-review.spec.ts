/**
 * Worktree sidebar load-failure visual-review harness.
 *
 * Drives the preview entry (`worktree-load-error-preview.html`) rather than
 * booting Electron: the real `SidebarContent`, seeded into each branch that can
 * mount `WorktreeLoadErrorBanner` or the workspace-service banner, against the
 * real theme tokens and `index.css`. A failed load is rare in a live session
 * and never happens on demand, which is why nobody had looked at it.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_LOAD_ERROR=1 npx playwright test --project=screenshots worktree-load-error-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_LOAD_ERROR  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR         output directory (default artifacts/worktree-load-error-shots)
 *   DAINTREE_SHOT_THEMES      comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Never writes a frame it has not verified: the shell must carry the state the
 * fixture names, and the test counts the files on disk at the end.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_LOAD_ERROR;

/** `DEFAULT_SIDEBAR_WIDTH`, and `MIN_SIDEBAR_WIDTH` — the floor the resizer stops at. */
const DEFAULT_WIDTH = 350;
const NARROW_WIDTH = 200;
const HEIGHT = 480;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ??
    path.join(process.cwd(), "artifacts", "worktree-load-error-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/**
 * Mirrors `FIXTURES` in the preview entry, which runs under Vite's aliases and
 * can't be imported here. `expect` is the text the frame must carry before it
 * is written, so a fixture that fell through to the wrong branch fails loudly.
 */
const FIXTURES: ReadonlyArray<{ name: string; expect: RegExp[]; absent?: RegExp[] }> = [
  { name: "loading", expect: [/Couldn.t load worktrees/] },
  { name: "empty", expect: [/Couldn.t load worktrees/] },
  { name: "populated", expect: [/Couldn.t load worktrees/, /issue-12488-handback/] },
  { name: "long-error", expect: [/Couldn.t load worktrees/] },
  { name: "disconnected", expect: [/isn.t connected/] },
  // Retry cannot bring back a crashed host, so the load banner yields here.
  {
    name: "with-service-error",
    expect: [/Workspace service unavailable/],
    absent: [/Couldn.t load worktrees/],
  },
  { name: "disconnected-service-error", expect: [/Workspace service unavailable/] },
];

const NARROW_FIXTURES = ["loading", "long-error", "with-service-error"] as const;

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

const shell = (page: Page) => page.locator("[data-preview-shell]");

async function open(page: Page, fixture: string, theme: string, width = DEFAULT_WIDTH) {
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: width + 40, height: HEIGHT });
  await page.goto(
    `${baseURL}/worktree-load-error-preview.html?theme=${theme}&fixture=${fixture}&width=${width}`
  );
  await expect(shell(page)).toBeAttached({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  // The banner's entrance is a 250ms slide, and the skeleton's pulse is held
  // back 400ms by its Doherty gate; let both land.
  await page.waitForTimeout(900);
}

async function snap(
  target: Locator,
  file: string,
  expects: RegExp[],
  absent: RegExp[] = []
): Promise<string> {
  await expect(target).toBeVisible();
  for (const text of expects) await expect(target).toContainText(text);
  for (const text of absent) await expect(target).not.toContainText(text);
  const box = await target.boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: target has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const out = path.join(OUT_DIR, file);
  // Not `animations: "disabled"`: that cancels the skeleton's infinite pulse
  // back to its gated, fully transparent first frame, which photographs the
  // loading branch as an empty column.
  await target.screenshot({ path: out });
  return out;
}

test("Worktree load error — states, widths and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_LOAD_ERROR is required for the worktree-load-error capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_LOAD_ERROR=1 to run the capture");
  test.setTimeout(300_000);

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const theme of THEMES) {
    for (const fixture of FIXTURES) {
      await open(page, fixture.name, theme);
      written.push(
        await snap(shell(page), `${fixture.name}-${theme}.png`, fixture.expect, fixture.absent)
      );
    }
  }

  const theme = THEMES[0]!;
  for (const name of NARROW_FIXTURES) {
    const fixture = FIXTURES.find((f) => f.name === name)!;
    await open(page, name, theme, NARROW_WIDTH);
    written.push(
      await snap(shell(page), `${name}-${theme}-narrow.png`, fixture.expect, fixture.absent)
    );
  }

  // Keyboard focus on the recovery action, reached the way a keyboard user does.
  {
    await open(page, "loading", theme);
    const retry = page.getByRole("button", { name: /retry/i }).first();
    await retry.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(retry).toBeFocused();
    await page.waitForTimeout(250);
    written.push(await snap(shell(page), `focus-retry-${theme}.png`, FIXTURES[0]!.expect));
  }

  expect(pageErrors, `preview page threw: ${pageErrors.join(" | ")}`).toEqual([]);

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * FIXTURES.length + NARROW_FIXTURES.length + 1);
  console.log(`[worktree-load-error-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
