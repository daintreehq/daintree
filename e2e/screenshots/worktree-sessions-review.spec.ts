/**
 * Worktree card "Active sessions" visual-review harness.
 *
 * The expanded session list is the densest part of the sidebar card — a glyph,
 * a title, a state mark, a location mark and a grip per row — and it only
 * matters beside the collapsed Details row it sits under. So this drives the
 * preview entry (`worktree-sessions-preview.html`), which mounts the REAL
 * `WorktreeTerminalSection` and `WorktreeDetailsSection` from fixtures under
 * the real theme tokens, rather than booting Electron and launching PTYs.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_SESSIONS_LIST=1 npx playwright test --project=screenshots worktree-sessions-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SESSIONS_LIST  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR            output directory (default artifacts/sessions-shots)
 *   DAINTREE_SHOT_THEMES         comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Never writes a PNG it has not verified: `snap()` asserts a real box, and the
 * test counts the files itself at the end.
 */

import { test, expect, type Page } from "@playwright/test";

// 2x, so a 12px glyph can be judged as a shape rather than a smudge.
test.use({ deviceScaleFactor: 2 });
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient, makeSnap } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_SESSIONS_LIST;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "sessions-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors `FIXTURES` in the preview entry, which cannot be imported under Node. */
const FIXTURES = ["two-agents", "mixed", "armed", "hint", "collapsed"] as const;

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

async function open(
  page: Page,
  fixture: string,
  theme: string,
  opts: { variant?: "sidebar" | "grid"; width?: number } = {}
) {
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: 560, height: 600 });
  const q = new URLSearchParams({ theme, fixture, variant: opts.variant ?? "sidebar" });
  if (opts.width) q.set("width", String(opts.width));
  await page.goto(`${baseURL}/worktree-sessions-preview.html?${q}`);
  const card = page.locator("[data-preview-card]");
  await expect(card, `fixture "${fixture}" rendered no card`).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return card;
}

test("Worktree card active sessions — states, variants and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SESSIONS_LIST is required for the sessions capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_SESSIONS_LIST=1 to run the capture");

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const theme of THEMES) {
    for (const fixture of FIXTURES) {
      const card = await open(page, fixture, theme);
      if (fixture !== "collapsed") {
        await expect(card.locator("[data-terminal-id]").first()).toBeVisible();
      }
      written.push(await snap(card, `${fixture}-${theme}.png`));
    }
  }

  const theme = THEMES[0]!;

  // Pointer over a row: the state where the row's controls are all on show.
  {
    const card = await open(page, "mixed", theme);
    await card.locator("[data-terminal-id]").nth(1).hover();
    await page.waitForTimeout(200);
    written.push(await snap(card, `hover-${theme}.png`));
  }

  // Keyboard focus on a row: whatever hover reveals, focus must reveal too.
  {
    const card = await open(page, "mixed", theme);
    await card.locator("[data-terminal-id]").first().locator("button").first().focus();
    await page.keyboard.press("Tab");
    await page.waitForTimeout(200);
    written.push(await snap(card, `keyboard-focus-${theme}.png`));
  }

  // The narrowest sidebar the resizer allows.
  {
    const card = await open(page, "mixed", theme, { width: 220 });
    written.push(await snap(card, `mixed-${theme}-narrow.png`));
  }

  // The overview grid's card, which uses the same rows one density step looser.
  {
    const card = await open(page, "mixed", theme, { variant: "grid" });
    written.push(await snap(card, `mixed-${theme}-grid.png`));
  }

  expect(pageErrors, `preview page threw: ${pageErrors.join(" | ")}`).toEqual([]);

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  console.log(`[sessions-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
