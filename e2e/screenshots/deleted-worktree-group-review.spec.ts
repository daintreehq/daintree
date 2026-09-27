/**
 * Deleted-worktree rows visual-review harness.
 *
 * A deleted row exists only for the minute after an agent removes its own
 * worktree with terminals still running, so it is almost never on screen when
 * anyone is looking. This drives the preview entry
 * (`deleted-worktree-group-preview.html`), which mounts the REAL
 * `SidebarContent` with seeded deleted worktrees between live rows: the lone
 * `DeletedWorktreeCard`, and the `DeletedWorktreeGroup` summary collapsed (with
 * its rail of rescuable terminals) and expanded.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_DELETED_GROUP=1 npx playwright test --project=screenshots deleted-worktree-group-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_DELETED_GROUP  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR            output directory (default artifacts/deleted-group-shots)
 *   DAINTREE_SHOT_THEMES         comma-separated theme sweep (default: four
 *                                themes spanning light, dark and low-contrast dark)
 *
 * Never writes a PNG it has not verified: `snap()` asserts a real box, the
 * interaction shots assert the state they claim before writing, and the test
 * counts the files itself.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient, makeSnap } from "../helpers/previewHarness";

test.use({ deviceScaleFactor: 2 });

const ENABLED = !!process.env.DAINTREE_SHOT_DELETED_GROUP;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "deleted-group-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib,redwoods")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** One dark and one light theme carry the per-state shots. */
const FOCUS_THEMES = ["daintree", "bondi"];

/** Mirrors FIXTURE_NAMES in the preview entry, which cannot be imported under Node. */
const FIXTURES = [
  "group-collapsed",
  "group-expanded",
  "group-no-cleanup",
  "group-pair",
  "single",
  "single-held",
] as const;
type Fixture = (typeof FIXTURES)[number];

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

async function open(page: Page, fixture: Fixture, theme: string, width = 350) {
  await stubViteHmrClient(page);
  await page.setViewportSize({
    width: width + 40,
    height: fixture === "group-expanded" ? 1080 : 720,
  });
  // The pointer survives navigation; park it so a previous hover does not ride in.
  await page.mouse.move(width + 30, 10);
  await page.goto(
    `${baseURL}/deleted-worktree-group-preview.html?theme=${theme}&fixture=${fixture}&width=${width}`
  );
  const shell = page.locator("[data-preview-shell]");
  await expect(shell, `fixture "${fixture}" rendered nothing`).toBeVisible();
  if (fixture.startsWith("group")) {
    await expect(page.getByTestId("deleted-worktree-group")).toBeVisible();
  } else {
    await expect(page.locator("[data-deleted-worktree-id]")).toHaveCount(1);
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  return shell;
}

test("Deleted-worktree rows — group, cards, states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_DELETED_GROUP is required for the deleted-worktree capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_DELETED_GROUP=1 to run the capture");

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const theme of THEMES) {
    written.push(
      await snap(await open(page, "group-collapsed", theme), `group-collapsed-${theme}.png`)
    );
    written.push(
      await snap(await open(page, "group-expanded", theme), `group-expanded-${theme}.png`)
    );
  }

  for (const theme of FOCUS_THEMES) {
    for (const fixture of FIXTURES) {
      if (fixture === "group-collapsed" || fixture === "group-expanded") continue;
      written.push(await snap(await open(page, fixture, theme), `${fixture}-${theme}.png`));
    }

    // Pointer over a rail chip: the grip's hover state and the chip's lift.
    {
      const shell = await open(page, "group-collapsed", theme);
      const chip = page.getByRole("button", { name: /^Codex in deleted worktree/ });
      await chip.hover();
      await page.waitForTimeout(200);
      written.push(await snap(shell, `hover-chip-${theme}.png`));
    }

    // Pointer over the summary row's disclosure.
    {
      const shell = await open(page, "group-collapsed", theme);
      await page.getByTestId("deleted-worktree-group").locator("button[aria-expanded]").hover();
      await page.waitForTimeout(200);
      written.push(await snap(shell, `hover-header-${theme}.png`));
    }

    // Keyboard focus on the first drag handle.
    {
      const shell = await open(page, "group-collapsed", theme);
      await page.keyboard.press("Shift");
      const grip = page.getByRole("button", { name: /^Drag to rescue Claude/ });
      await grip.focus();
      await expect(grip).toBeFocused();
      await page.waitForTimeout(200);
      written.push(await snap(shell, `focus-grip-${theme}.png`));
    }

    // The bulk clear's tooltip, which is the only place its full label shows.
    {
      await open(page, "group-collapsed", theme);
      await page
        .getByTestId("deleted-worktree-group")
        .getByRole("button", { name: /^Close \d+ terminals?$/ })
        .hover();
      await expect(page.getByRole("tooltip")).toContainText(/^Close \d+ terminals?$/);
      await page.waitForTimeout(200);
      const file = `tooltip-clear-${theme}.png`;
      await page.screenshot({ path: path.join(OUT_DIR, file) });
      written.push(file);
    }

    // The narrowest sidebar, where the header's count competes with the timer.
    written.push(
      await snap(
        await open(page, "group-collapsed", theme, 240),
        `group-collapsed-${theme}-narrow.png`
      )
    );

    await page.emulateMedia({ contrast: "more" });
    written.push(
      await snap(
        await open(page, "group-collapsed", theme),
        `group-collapsed-${theme}-contrast-more.png`
      )
    );
    await page.emulateMedia({ contrast: "no-preference", forcedColors: "active" });
    written.push(
      await snap(
        await open(page, "group-collapsed", theme),
        `group-collapsed-${theme}-forced-colors.png`
      )
    );
    await page.emulateMedia({ forcedColors: "none" });
  }

  expect(pageErrors, `preview page threw: ${pageErrors.join(" | ")}`).toEqual([]);

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  console.log(`[deleted-group-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
