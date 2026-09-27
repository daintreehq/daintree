/**
 * Attach-issue dialog visual-review harness, Vite edition.
 *
 * Renders the real `IssuePickerDialog` through `issue-picker-preview.html`, with
 * its `forge.listIssues` call answered from fixtures by
 * `src/components/Worktree/__preview__/issuePickerBridge.ts`. The fixtures honour
 * the dialog's own state and search options, so the filter pills and the search
 * field drive real re-fetches. No build and no Electron.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_ISSUE_PICKER=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     npx playwright test --project=screenshots issue-picker-preview-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_ISSUE_PICKER  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR          output dir (default artifacts/issue-picker-shots)
 *   DAINTREE_SHOT_THEMES        comma-separated theme sweep (default daintree,bondi,namib)
 *
 * Output: <state>-<theme>.png. The test counts the files itself rather than
 * trusting its own exit code.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_ISSUE_PICKER;
const OUT_DIR = path.resolve(
  process.env.DESIGN_CAPTURE_DIR ?? path.join(process.cwd(), "artifacts", "issue-picker-shots")
);
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const ATTACH_TIMEOUT_MS = 30_000;
/** The search debounce is 300ms; the fixture answers 40ms after that. */
const FETCH_SETTLE_MS = 600;

const snap = makeSnap(OUT_DIR);

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

/** Hold one page open until Vite's optimizer stops force-reloading it. */
async function settleDevServer(context: BrowserContext) {
  const page = await context.newPage();
  await stubViteHmrClient(page);
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  await page.goto(`${server!.baseURL}/issue-picker-preview.html`);
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const ready = await page.locator('div[aria-modal="true"]').count();
    if (navigations === before && ready === 1) break;
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
        console.warn(`[issue-picker-shots] renderer crashed on ${what}; retrying once`);
        continue;
      }
      throw new Error(`${what}: ${String(error)}`, { cause: error });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function open(page: Page, theme: string, query = ""): Promise<Locator> {
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto(`${server!.baseURL}/issue-picker-preview.html?theme=${theme}${query}`);
  const panel = page.locator('div[aria-modal="true"] > div').first();
  await expect(panel).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready);
  // Entrance is 200ms and the input takes focus 100ms after open; the first
  // fetch also runs through the 300ms search debounce.
  await page.waitForTimeout(FETCH_SETTLE_MS + 200);
  return panel;
}

function search(page: Page): Locator {
  return page.locator('div[aria-modal="true"] input').first();
}

interface State {
  name: string;
  query?: string;
  run?: (page: Page) => Promise<void>;
  /** Text the capture must show, or it is a picture of the wrong state. */
  expectText?: string;
}

const STATES: State[] = [
  { name: "10-open-list", expectText: "Publish Daintree to winget" },
  { name: "12-attached", query: "&attached=11957", expectText: "#11957" },
  {
    name: "15-row-hover",
    run: async (page) => {
      await page.getByRole("option").nth(3).hover();
      await page.waitForTimeout(200);
    },
  },
  {
    name: "18-keyboard-cursor",
    run: async (page) => {
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(200);
    },
  },
  {
    name: "20-closed-filter",
    run: async (page) => {
      await page.getByRole("button", { name: /^closed$/i }).click();
      await page.waitForTimeout(FETCH_SETTLE_MS);
    },
    expectText: "Theme picker previews",
  },
  {
    name: "22-all-filter",
    run: async (page) => {
      await page.getByRole("button", { name: /^all$/i }).click();
      await page.waitForTimeout(FETCH_SETTLE_MS);
    },
  },
  {
    name: "25-filter-keyboard-focus",
    run: async (page) => {
      // Keyboard route from the search field onto the filter control.
      await search(page).focus();
      await page.keyboard.press("Tab");
      await page.waitForTimeout(200);
    },
  },
  {
    name: "30-search-results",
    run: async (page) => {
      await search(page).fill("worktree");
      await page.waitForTimeout(FETCH_SETTLE_MS);
    },
  },
  {
    name: "35-no-matches",
    run: async (page) => {
      await search(page).fill("keychain");
      await page.waitForTimeout(FETCH_SETTLE_MS);
    },
    expectText: "keychain",
  },
  { name: "40-zero-data", query: "&outcome=empty" },
  { name: "45-loading", query: "&outcome=hang" },
  { name: "50-error", query: "&outcome=error", expectText: "502" },
  { name: "52-error-attached", query: "&outcome=error&attached=11957", expectText: "502" },
];

test("issue picker preview — every state, every theme", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_ISSUE_PICKER is required for the issue picker capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_ISSUE_PICKER=1 to run the capture");
  test.setTimeout(10 * 60_000);

  await settleDevServer(context);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const state of STATES) {
      written.push(
        await withPage(context, `${state.name} ${theme}`, async (page) => {
          const panel = await open(page, theme, state.query);
          await state.run?.(page);
          if (state.expectText) {
            await expect(panel, `${state.name} is not the state it names`).toContainText(
              state.expectText
            );
          }
          return snap(panel, `${state.name}-${theme}.png`);
        })
      );
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * STATES.length);
  console.log(`[issue-picker-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
