/**
 * "Move to worktree…" picker visual-review harness, Vite edition.
 *
 * Renders the real `MoveToWorktreePicker` through `move-to-worktree-preview.html`,
 * hung off a stand-in pane header, with worktrees whose titles and branches
 * share long prefixes (see `src/components/Panel/__preview__/moveToWorktreePicker.tsx`).
 * No build and no Electron.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_MOVE_PICKER=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     npx playwright test --project=screenshots move-to-worktree-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_MOVE_PICKER  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR         output dir (default artifacts/move-to-worktree-shots)
 *   DAINTREE_SHOT_THEMES       comma-separated theme sweep (default daintree,bondi,namib)
 *
 * Output: <state>-<theme>.png, plus <state>-<theme>.json recording which row is
 * active, which text is clipped and what any open tooltip says. The test counts
 * the files itself rather than trusting its own exit code.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_MOVE_PICKER;
const OUT_DIR = path.resolve(
  process.env.DESIGN_CAPTURE_DIR ?? path.join(process.cwd(), "artifacts", "move-to-worktree-shots")
);
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const ATTACH_TIMEOUT_MS = 30_000;
/** Palette entrance is 150ms; the tooltip's own delay is 300ms plus its 150ms entrance. */
const SETTLE_MS = 350;
const TOOLTIP_SETTLE_MS = 700;
/** The default row reveals after the app's hover delay (500ms), then its entrance. */
const PAUSE_REVEAL_SETTLE_MS = 900;
const VIEWPORT = { width: 920, height: 540 };

test.use({ deviceScaleFactor: 2 });
let server: PreviewServer | undefined;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

const DIALOG = '[role="dialog"][aria-label="Move to worktree"]';

/** Hold one page open until Vite's optimizer stops force-reloading it. */
async function settleDevServer(context: BrowserContext) {
  const page = await context.newPage();
  await stubViteHmrClient(page);
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  await page.goto(`${server!.baseURL}/move-to-worktree-preview.html`);
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const ready = await page.locator(`${DIALOG} [role="option"]`).count();
    if (navigations === before && ready > 0) break;
  }
  await page.close();
}

async function withPage<T>(
  context: BrowserContext,
  what: string,
  body: (page: Page) => Promise<T>
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const page = await context.newPage();
    await stubViteHmrClient(page);
    let crashed = false;
    const errors: string[] = [];
    page.on("crash", () => {
      crashed = true;
    });
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      const result = await body(page);
      if (errors.length > 0) throw new Error(`${what}: page threw: ${errors.join(" | ")}`);
      return result;
    } catch (error) {
      if (crashed && attempt === 1) {
        console.warn(`[move-picker-shots] renderer crashed on ${what}; retrying once`);
        continue;
      }
      throw new Error(`${what}: ${String(error)}`, { cause: error });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function open(page: Page, theme: string, query = ""): Promise<void> {
  await page.setViewportSize(VIEWPORT);
  await page.goto(`${server!.baseURL}/move-to-worktree-preview.html?theme=${theme}${query}`);
  const options = page.locator(`${DIALOG} [role="option"]`);
  await expect(options.first()).toBeVisible({ timeout: ATTACH_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(SETTLE_MS);
}

/** What the pixels should be showing, read from the DOM, for the sidecar. */
async function describe(page: Page) {
  return page.evaluate((dialogSelector) => {
    const dialog = document.querySelector(dialogSelector);
    const rows = Array.from(dialog?.querySelectorAll('[role="option"]') ?? []);
    const clipped = (el: Element) => el.scrollWidth > el.clientWidth + 1;
    return {
      activeElement:
        document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName,
      rows: rows.map((row) => ({
        text: (row as HTMLElement).innerText.replace(/\n/g, " | "),
        selected: row.getAttribute("aria-selected") === "true",
        current: row.getAttribute("aria-current") === "true",
        clipped: Array.from(row.querySelectorAll("span"))
          .filter((span) => span.children.length === 0 && clipped(span))
          .map((span) => span.textContent),
      })),
      tooltips: Array.from(document.querySelectorAll('[role="tooltip"]')).map(
        (tip) => tip.textContent
      ),
    };
  }, DIALOG);
}

async function snap(page: Page, file: string): Promise<string> {
  const dialog = page.locator(DIALOG);
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  if (!box || box.width < 100 || box.height < 100) {
    throw new Error(`${file}: picker has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const out = path.join(OUT_DIR, file);
  // The page, not the dialog: a revealed name renders in a tooltip portalled
  // outside it, and that tooltip is half of what these states are for.
  await page.screenshot({ path: out, clip: { x: 0, y: 0, ...VIEWPORT } });
  writeFileSync(out.replace(/\.png$/, ".json"), JSON.stringify(await describe(page), null, 2));
  return out;
}

async function arrowDown(page: Page, times: number) {
  for (let i = 0; i < times; i++) await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(TOOLTIP_SETTLE_MS);
}

interface State {
  name: string;
  query?: string;
  run?: (page: Page) => Promise<void>;
  /** The row that must be highlighted, or the capture is of the wrong state. */
  expectActive?: string;
}

const STATES: State[] = [
  { name: "10-rest", expectActive: "daintree" },
  {
    // Main is where the pane lives, so the first target is a clipped issue
    // row; after a pause it shows its full name without a key pressed.
    name: "15-current-main",
    query: "&current=main",
    run: (page) => page.waitForTimeout(PAUSE_REVEAL_SETTLE_MS),
    expectActive: "Hosts overview: show",
  },
  {
    name: "20-keyboard-similar-title",
    run: (page) => arrowDown(page, 2),
    expectActive: "keep the exchange thread",
  },
  {
    // Escape spends itself on the reveal; the picker, its cursor and its
    // search focus stay where they were.
    name: "25-keyboard-reveal-escape",
    run: async (page) => {
      await arrowDown(page, 2);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(TOOLTIP_SETTLE_MS);
    },
    expectActive: "keep the exchange thread",
  },
  {
    name: "30-keyboard-branch-title",
    run: (page) => arrowDown(page, 5),
    expectActive: "endpoint-close-revoke",
  },
  {
    name: "40-pointer-hover",
    run: async (page) => {
      await page
        .locator(`${DIALOG} [role="option"]`)
        .filter({ hasText: "idle-link-release" })
        .hover();
      await page.waitForTimeout(TOOLTIP_SETTLE_MS);
    },
    expectActive: "idle-link-release",
  },
  {
    // Typed, then paused: the first result is what Enter takes.
    name: "45-search-first-result",
    run: async (page) => {
      await page.keyboard.type("restart");
      await page.waitForTimeout(PAUSE_REVEAL_SETTLE_MS);
    },
    expectActive: "idle-link-release",
  },
  {
    // Escape inside the pause: the pause must not bring the reveal back.
    name: "47-search-escape-before-pause",
    run: async (page) => {
      await page.keyboard.type("restart");
      await page.keyboard.press("Home");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(PAUSE_REVEAL_SETTLE_MS);
    },
    expectActive: "idle-link-release",
  },
  {
    name: "50-search",
    run: async (page) => {
      await page.keyboard.type("hosts overview");
      await page.waitForTimeout(SETTLE_MS);
      await arrowDown(page, 1);
    },
  },
];

test("move to worktree picker — every state, every theme", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_MOVE_PICKER is required for the move-to-worktree capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_MOVE_PICKER=1 to run the capture");
  test.setTimeout(10 * 60_000);

  await settleDevServer(context);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const state of STATES) {
      written.push(
        await withPage(context, `${state.name} ${theme}`, async (page) => {
          await open(page, theme, state.query);
          await state.run?.(page);
          if (state.expectActive) {
            await expect(
              page.locator(`${DIALOG} [role="option"][aria-selected="true"]`),
              `${state.name} is not the state it names`
            ).toContainText(state.expectActive);
          }
          return snap(page, `${state.name}-${theme}.png`);
        })
      );
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * STATES.length);
  console.log(`[move-picker-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
