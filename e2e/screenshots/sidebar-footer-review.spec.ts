/**
 * Sidebar bottom-section visual-review harness.
 *
 * The footer of the project tree is three strips that grew separately —
 * `QuickRun`, the plugin indicator, and the `ProjectResourceBadge` status row
 * carrying the keep-awake mark — and they are only ever seen stacked. Most of
 * the states worth reviewing are store combinations a real session reaches
 * rarely and never on demand: a wake lock held, four projects running, memory
 * gone critical, no worktree selected, a branch name wider than the column.
 *
 * So this drives the component's own preview entry
 * (`sidebar-footer-preview.html`) rather than booting Electron: the real
 * `QuickRun` and `SidebarStatusBar`, the real theme tokens through
 * `applyAppThemeToRoot`, the real `index.css`, in the 320px column the sidebar
 * actually gets, with the tree above stubbed so the footer's weight is
 * judgeable against the chrome it sits under.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_FOOTER=1 npx playwright test --project=screenshots sidebar-footer-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_FOOTER  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR     output directory (default artifacts/sidebar-footer-shots)
 *   DAINTREE_SHOT_THEMES  comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * The theme trio is not arbitrary: `daintree` is the dark default, `bondi` is
 * light, and `namib` is the dark theme where `text-muted` bottoms out at
 * 2.22:1 — the worst case this footer has to survive.
 *
 * Hard rule, inherited from the siblings: never write a PNG that has not been
 * verified. `snap()` asserts a real box before it writes, and the test counts
 * the files itself at the end rather than trusting the exit code.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient, makeSnap } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_FOOTER;

/** The sidebar's canonical width, and the narrowest it is worth shipping. */
const DEFAULT_WIDTH = 320;
const NARROW_WIDTH = 240;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "sidebar-footer-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors `FIXTURES` in the preview entry. Duplicated rather than imported: the
 *  entry runs under Vite with `@/` aliases and `index.css`, neither of which
 *  resolves under Playwright's Node loader. */
const FIXTURES = [
  "default",
  "idle",
  "nothing-running",
  "many-projects",
  "memory-critical",
  "collapsed",
  "toggles-active",
  "no-worktree",
  "long-branch",
  "running-tasks",
] as const;

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";
let snap: ReturnType<typeof makeSnap>;

test.beforeAll(async () => {
  // No `test.skip` here: `test.info()` is unavailable in a beforeAll hook, so
  // the structured-skip annotation the repo requires cannot be attached. The
  // test body carries the skip; this hook simply does no work when unset.
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

/** Load one fixture in one theme at one width, and settle it. */
async function open(
  page: Page,
  fixture: string,
  theme: string,
  width = DEFAULT_WIDTH
): Promise<Locator> {
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: width + 40, height: 760 });
  await page.goto(`${baseURL}/sidebar-footer-preview.html?theme=${theme}&fixture=${fixture}&width=${width}`);
  const shell = page.locator("[data-preview-shell]");
  await expect(shell, `fixture "${fixture}" rendered no shell`).toBeAttached();
  // Type metrics drive every measurement in a strip this dense, so a capture
  // taken before the fonts land measures the fallback face.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return shell;
}

/** The footer alone, for the tight crops; the shell for the in-context ones. */
function footer(page: Page): Locator {
  return page.locator("[data-footer-region]");
}

test("Sidebar footer — states, widths and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_FOOTER is required for the sidebar-footer capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_FOOTER=1 to run the capture");

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const theme of THEMES) {
    for (const fixture of FIXTURES) {
      const shell = await open(page, fixture, theme);

      // `collapsed` is a local-state fixture: QuickRun defaults to expanded and
      // keeps `isExpanded` in a `useState` with no store and no persistence, so
      // the only way to reach the state is to click the header the way a user
      // would.
      if (fixture === "collapsed") {
        await page.getByRole("button", { expanded: true }).first().click();
        await page.waitForTimeout(200);
      }

      written.push(await snap(shell, `${fixture}-${theme}.png`));
    }
  }

  // Interaction states, in the default theme only — these are layout and
  // affordance questions, not palette ones.
  {
    const theme = THEMES[0]!;

    // Something typed: the run button leaves its disabled treatment and the
    // suggestion menu opens upward over the tree.
    await open(page, "default", theme);
    const input = page.getByLabel("Command input");
    await input.click();
    await input.fill("npm run dev");
    await page.waitForTimeout(250);
    written.push(await snap(page.locator("[data-preview-shell]"), `typing-${theme}.png`));

    // Focused with an empty input: the suggestion list at its fullest, which is
    // where the footer's real occupied height shows up.
    await open(page, "default", theme);
    await page.getByLabel("Command input").click();
    await page.waitForTimeout(250);
    written.push(await snap(page.locator("[data-preview-shell]"), `suggestions-${theme}.png`));

    // The status row on its own, at 3x the size, so the dot and the cup can be
    // judged as glyphs rather than as smudges.
    await open(page, "many-projects", theme);
    written.push(
      await snap(page.locator("[data-sidebar-status-bar]"), `status-row-${theme}.png`)
    );
  }

  // The pressure case: the narrowest column worth shipping, default theme.
  {
    const theme = THEMES[0]!;
    for (const fixture of ["default", "long-branch", "running-tasks"] as const) {
      await open(page, fixture, theme, NARROW_WIDTH);
      written.push(await snap(footer(page), `${fixture}-${theme}-narrow.png`));
    }
  }

  expect(pageErrors, `preview page threw: ${pageErrors.join(" | ")}`).toEqual([]);

  // Count the files ourselves. A harness that trusts its own exit code is how a
  // review ends up reasoning about screenshots that were never written.
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBeGreaterThanOrEqual(THEMES.length * FIXTURES.length);
  console.log(`[sidebar-footer-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
