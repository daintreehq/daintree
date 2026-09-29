/**
 * Review Hub PR status chip + CI checks popover visual-review harness.
 *
 * The popover's states — a mixed run with failures, an all-green run, a run
 * still in flight, a long matrix, no checks, no such PR, a read that failed,
 * and the Doherty-gated skeleton — are hard to reach on demand from a real
 * forge. So this drives the popover's own preview entry
 * (`pr-checks-preview.html`), which mounts the REAL `PrStatusChip` and
 * `PrChecksPopover` against the real theme tokens and `index.css`, with the
 * bridge's `forge.getChecks` answering from a fixture.
 *
 *   DAINTREE_SHOT_PRCHECKS=1 npx playwright test --project=screenshots pr-checks-popover-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PRCHECKS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR       output directory (default artifacts/pr-checks-shots)
 *   DAINTREE_SHOT_THEMES    comma-separated sweep (default daintree,svalbard,namib);
 *                           the first theme gets every state, the rest a subset
 *
 * Never writes a PNG it has not verified: every shot asserts the popover reached
 * the fixture's state before the frame is written, and the test counts the files
 * itself at the end.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_PRCHECKS;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "pr-checks-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,svalbard,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const TRIGGER = '[data-testid="pr-checks-trigger"]';
const POPOVER = '[data-testid="pr-checks-popover"]';

type Interaction = "none" | "hover-row" | "keyboard-row" | "send" | "keyboard-reload";

interface Shot {
  name: string;
  fixture: string;
  /** Marker inside the popover that proves the fixture's state painted. */
  marker: string;
  interaction?: Interaction;
  /** Extra settle, for the Doherty-gated skeleton. */
  waitMs?: number;
  /** Also captured in the secondary themes. */
  sweep?: boolean;
}

const LIST = '[data-testid="pr-checks-list"]';

const SHOTS: Shot[] = [
  { name: "chip-rest", fixture: "mixed", marker: "", sweep: true },
  { name: "mixed", fixture: "mixed", marker: LIST, sweep: true },
  { name: "passing", fixture: "passing", marker: LIST, sweep: true },
  { name: "running", fixture: "running", marker: LIST },
  { name: "many", fixture: "many", marker: LIST, sweep: true },
  { name: "empty", fixture: "empty", marker: '[data-testid="pr-checks-empty"]', sweep: true },
  { name: "missing", fixture: "missing", marker: '[data-testid="pr-checks-missing"]' },
  { name: "error", fixture: "error", marker: '[data-testid="pr-checks-error"]', sweep: true },
  {
    name: "loading",
    fixture: "loading",
    marker: '[data-testid="pr-checks-skeleton"]',
    waitMs: 900,
  },
  { name: "mixed-hover-row", fixture: "mixed", marker: LIST, interaction: "hover-row" },
  { name: "mixed-keyboard-row", fixture: "mixed", marker: LIST, interaction: "keyboard-row" },
  {
    name: "mixed-send-hint",
    fixture: "mixed",
    marker: '[data-testid="pr-checks-send-hint"]',
    interaction: "send",
  },
  {
    name: "error-keyboard-reload",
    fixture: "error",
    marker: '[data-testid="pr-checks-error"]',
    interaction: "keyboard-reload",
  },
];

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

async function load(page: Page, fixture: string, theme: string): Promise<Locator> {
  await stubViteHmrClient(page);
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 820, height: 640 });
  const url = `${baseURL}/pr-checks-preview.html?theme=${theme}&fixture=${fixture}`;
  const shell = page.locator("[data-preview-shell]");
  // The first load after a dependency change can answer 504 "Outdated Optimize
  // Dep" while Vite re-optimises; one reload after it settles is enough.
  for (let attempt = 0; ; attempt++) {
    await page.goto(url);
    try {
      await expect(shell).toBeAttached({ timeout: attempt === 0 ? 15_000 : 30_000 });
      break;
    } catch (error) {
      if (attempt >= 2) throw new Error(`fixture "${fixture}" rendered no shell`, { cause: error });
    }
  }
  await expect(shell.locator(TRIGGER)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return shell;
}

/** Tab until `target` holds focus — a fixed press count lands wherever the order puts it. */
async function tabTo(page: Page, target: Locator, maxPresses = 12): Promise<boolean> {
  for (let i = 0; i < maxPresses; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement)) return true;
  }
  return false;
}

/** The header row plus the open popover, as one clip. */
async function snapUnion(page: Page, shell: Locator, popover: Locator | null, file: string) {
  const header = shell.locator(":scope > div").first();
  const a = await header.boundingBox();
  if (!a || a.width < 8 || a.height < 8) throw new Error(`${file}: header has no real box`);
  let box = a;
  if (popover) {
    const b = await popover.boundingBox();
    if (!b || b.width < 8 || b.height < 8) throw new Error(`${file}: popover has no real box`);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    box = {
      x,
      y,
      width: Math.max(a.x + a.width, b.x + b.width) - x,
      height: Math.max(a.y + a.height, b.y + b.height) - y,
    };
  }
  const pad = 12;
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: box.width + pad * 2,
      height: box.height + pad * 2,
    },
  });
  return out;
}

test("PR checks popover — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PRCHECKS is required for the PR checks capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_PRCHECKS=1 to run the capture");
  test.setTimeout(10 * 60_000);

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  let expected = 0;
  for (const [i, theme] of THEMES.entries()) {
    for (const shot of SHOTS) {
      if (i > 0 && !shot.sweep) continue;
      expected++;
      const file = `${shot.name}-${theme}.png`;
      const shell = await load(page, shot.fixture, theme);
      const trigger = shell.locator(TRIGGER);

      if (!shot.marker) {
        await page.waitForTimeout(300);
        written.push(await snapUnion(page, shell, null, file));
        continue;
      }

      const popover = page.locator(POPOVER);
      if (shot.interaction === "keyboard-row" || shot.interaction === "keyboard-reload") {
        // A keypress first, so the programmatic focus lands as :focus-visible.
        await page.keyboard.press("Shift");
        await trigger.focus();
        await page.keyboard.press("Enter");
      } else {
        await trigger.click();
      }
      await expect(popover, `${file}: popover never opened`).toBeVisible({ timeout: 5000 });

      if (shot.interaction === "send") {
        await popover.locator('[data-testid="pr-checks-send"]').click();
      }
      await expect(
        popover.locator(shot.marker),
        `${file}: state marker ${shot.marker} never painted`
      ).toBeVisible({ timeout: 5000 });

      if (shot.interaction === "hover-row") {
        await popover.locator(`${LIST} li`).nth(1).hover();
      }
      if (shot.interaction === "keyboard-row") {
        const action = popover.locator(`${LIST} li button`).first();
        expect(await tabTo(page, action), `${file}: row action never took focus`).toBe(true);
      }
      if (shot.interaction === "keyboard-reload") {
        const reload = popover.locator('[data-testid="pr-checks-reload"]');
        expect(await tabTo(page, reload), `${file}: reload never took focus`).toBe(true);
      }
      await page.waitForTimeout(shot.waitMs ?? 350);
      written.push(await snapUnion(page, shell, popover, file));
    }
  }

  expect(pageErrors, `page errors during capture:\n${pageErrors.join("\n")}`).toEqual([]);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(written.length).toBe(expected);
});
