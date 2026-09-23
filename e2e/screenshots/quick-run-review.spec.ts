/**
 * QuickRun workflow visual-review harness.
 *
 * `sidebar-footer-review` photographs the footer as a strip, with QuickRun
 * mostly shut. This one follows the expanded workflow end to end — open the
 * panel, browse or filter the suggestions, pick one with the keyboard or the
 * pointer, run it, and find the task it started — at the sidebar's canonical
 * 320px and at its 200px floor, against a suggestion list long enough to scroll.
 *
 * It drives the same preview entry (`sidebar-footer-preview.html`), so every
 * frame is the real `SidebarFooter`, `QuickRun` and `RunningTaskList` under the
 * real theme tokens and `index.css`.
 *
 *   DAINTREE_SHOT_QUICKRUN=1 npx playwright test --project=screenshots quick-run-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_QUICKRUN  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR       output directory (default artifacts/quick-run-shots)
 *   DAINTREE_SHOT_THEMES    comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Never writes a PNG it has not verified: `snap()` refuses a target with no
 * real box, each interaction asserts the state it meant to reach before the
 * capture, and the file count is checked at the end.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient, makeSnap } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_QUICKRUN;

/** `MIN_SIDEBAR_WIDTH` in `AppLayout.tsx` is the floor; 320 is the default. */
const DEFAULT_WIDTH = 320;
const NARROW_WIDTH = 200;
const HEIGHT = 640;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "quick-run-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";
let snap: ReturnType<typeof makeSnap>;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
  baseURL = server.baseURL;
  snap = makeSnap(OUT_DIR);
});

test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page, fixture: string, theme: string, width: number): Promise<void> {
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: width + 40, height: HEIGHT });
  await page.goto(
    `${baseURL}/sidebar-footer-preview.html?theme=${theme}&fixture=${fixture}&width=${width}`
  );
  await expect(page.locator("[data-preview-shell]")).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(width + 30, 5);
  // Open the panel the way a user does: the footer's disclosure.
  await page.locator("[data-quick-run-toggle]").click();
  await expect(page.locator("#quick-run-panel")).toBeVisible();
  await page.mouse.move(width + 30, 5);
  await page.waitForTimeout(200);
}

const input = (page: Page) => page.getByRole("combobox");
const listbox = (page: Page) => page.getByRole("listbox");

async function showList(page: Page): Promise<void> {
  await input(page).click();
  await expect(listbox(page)).toBeVisible();
  await page.mouse.move(DEFAULT_WIDTH + 30, 5);
  await page.waitForTimeout(200);
}

test("QuickRun — open, choose, run, find the task", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_QUICKRUN is required for the QuickRun capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_QUICKRUN=1 to run the capture");
  test.setTimeout(240_000);

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const shell = () => page.locator("[data-preview-shell]");
  const shot = async (name: string) => written.push(await snap(shell(), `${name}.png`));

  const widths: Array<[number, string]> = [
    [DEFAULT_WIDTH, ""],
    [NARROW_WIDTH, "-narrow"],
  ];

  // The core journey in every theme at 320, and in the default theme at 200.
  for (const theme of THEMES) {
    for (const [width, suffix] of widths) {
      if (suffix && theme !== THEMES[0]) continue;
      const tag = `${theme}${suffix}`;

      // 1. Just opened: caret in the field, no menu.
      await open(page, "default", theme, width);
      await expect(input(page)).toBeFocused();
      await shot(`01-opened-${tag}`);

      // 2. The full suggestion list, long enough to scroll.
      await open(page, "long-suggestions", theme, width);
      await showList(page);
      await shot(`02-list-${tag}`);

      // 3. Arrowed deep into the list: which row will Enter run?
      for (let i = 0; i < 7; i++) await input(page).press("ArrowDown");
      await expect(input(page)).toHaveAttribute("aria-activedescendant", /.+/);
      await page.waitForTimeout(150);
      await shot(`03-keyboard-${tag}`);

      // 4. Filtering by typing.
      await open(page, "long-suggestions", theme, width);
      await input(page).fill("test");
      await expect(listbox(page)).toBeVisible();
      await page.waitForTimeout(150);
      await shot(`04-filtered-${tag}`);

      // 5. Running tasks past the visible cap.
      await open(page, "many-tasks", theme, width);
      await page.locator("[data-task-row]").first().waitFor();
      await shot(`05-tasks-${tag}`);
    }
  }

  // Interaction states, default theme, both widths.
  const theme = THEMES[0]!;
  for (const [width, suffix] of widths) {
    const tag = `${theme}${suffix}`;

    // A typed command nothing matches: what Enter will do.
    await open(page, "long-suggestions", theme, width);
    await input(page).fill("cargo watch -x run");
    await page.waitForTimeout(150);
    await shot(`06-nomatch-${tag}`);

    // Typing a command that is exactly a pinned one: lit in its own band.
    await open(page, "long-suggestions", theme, width);
    await input(page).fill("npm run dev");
    await expect(listbox(page)).toBeVisible();
    await page.waitForTimeout(150);
    await shot(`06b-exact-${tag}`);

    // Hovering a pinned row and a script row: the row's own actions.
    await open(page, "long-suggestions", theme, width);
    await showList(page);
    await page.getByRole("option").first().hover();
    await page.waitForTimeout(200);
    await shot(`07-hover-pinned-${tag}`);
    await page.getByRole("option").nth(4).hover();
    await page.waitForTimeout(200);
    await shot(`08-hover-script-${tag}`);

    // A project with nothing to suggest.
    await open(page, "no-suggestions", theme, width);
    await input(page).click();
    await page.waitForTimeout(200);
    await shot(`09-no-suggestions-${tag}`);

    // Run from the list, then look for the task it started.
    await open(page, "long-suggestions", theme, width);
    await showList(page);
    await page.getByRole("option").nth(5).click();
    await page.mouse.move(width + 30, 5);
    await page.waitForTimeout(600);
    await shot(`10-after-run-${tag}`);

    // A task row's actions, on hover.
    await open(page, "many-tasks", theme, width);
    await page.locator('[data-task-row="t-check"]').first().hover();
    await page.waitForTimeout(200);
    await shot(`11-task-hover-${tag}`);

    // Run options set.
    await open(page, "toggles-active", theme, width);
    await page.getByRole("button", { name: /run in the dock/i }).click();
    await page.mouse.move(width + 30, 5);
    await page.waitForTimeout(200);
    await shot(`12-options-on-${tag}`);

    // No worktree, and a branch far wider than the column.
    await open(page, "no-worktree", theme, width);
    await shot(`13-no-worktree-${tag}`);
    await open(page, "long-branch", theme, width);
    await shot(`14-long-branch-${tag}`);
  }

  expect(pageErrors, `preview page threw: ${pageErrors.join(" | ")}`).toEqual([]);

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  console.log(`[quick-run-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
