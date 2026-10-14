/**
 * Running-processes dialog visual-review harness.
 *
 * Renders the product's own `ProcessesDialog` through a Vite preview page
 * (`processes-dialog-preview.html`) with the snapshot and dev-preview session
 * reads answered from fixtures: processes across several projects, an agent
 * with many children, a dev server, a trashed terminal counting down, an
 * unsampled row, processes left by closed terminals, and plugin processes.
 * No build and no Electron.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_PROCESSES=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     npx playwright test --project=screenshots processes-dialog-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PROCESSES  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR       output directory (default artifacts/processes-dialog-shots)
 *   DAINTREE_SHOT_THEMES     comma-separated theme sweep (default: daintree,bondi)
 *   DAINTREE_SHOT_ONLY       comma-separated state filter
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

const ENABLED = !!process.env.DAINTREE_SHOT_PROCESSES;
const OUT_DIR = path.resolve(
  process.env.DESIGN_CAPTURE_DIR ?? path.join(process.cwd(), "artifacts", "processes-dialog-shots")
);
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

const PAGE = "processes-dialog-preview.html";
const ATTACH_TIMEOUT_MS = 30_000;
const DIALOG = '[data-testid="processes-dialog"]';
const CONFIRM = '[role="alertdialog"]';
const MODAL = 'div[aria-modal="true"]';
/** A dialog card: the modal's only child. The first is the list, the last a confirm. */
const CARD = `${MODAL} > div`;

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
  await page.goto(`${server!.baseURL}/${PAGE}`);
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const ready = await page.locator("#root > *").count();
    if (navigations === before && ready > 0) break;
  }
  await page.close();
}

async function load(page: Page, theme: string, state: string, height = 1400): Promise<Locator> {
  await page.setViewportSize({ width: 1000, height });
  await page.goto(`${server!.baseURL}/${PAGE}?theme=${theme}&state=${state}`);
  await expect(page.locator("#root > *").first()).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready);
  const dialog = page.locator(DIALOG);
  await expect(dialog).toBeVisible({ timeout: ATTACH_TIMEOUT_MS });
  // Past the entrance, the first read and the focus handoff.
  await page.waitForTimeout(700);
  return page.locator(CARD).first();
}

async function populated(page: Page, theme: string): Promise<Locator> {
  const dialog = await load(page, theme, "populated");
  await expect(dialog.locator('[data-testid="process-row"]').first()).toBeVisible();
  return dialog;
}

interface State {
  name: string;
  capture: (page: Page, theme: string) => Promise<Locator>;
}

const STATES: State[] = [
  { name: "populated", capture: populated },
  {
    name: "row-hover",
    capture: async (page, theme) => {
      const dialog = await populated(page, theme);
      // The long dev-server title: its full text should be reachable.
      await dialog
        .getByText(/^npm run dev/)
        .first()
        .hover();
      await page.waitForTimeout(900);
      return dialog;
    },
  },
  {
    name: "identity-hover",
    capture: async (page, theme) => {
      const dialog = await populated(page, theme);
      // The abbreviated process names: every name should be one hover away.
      await dialog
        .locator('[data-terminal-id="claude-main"]')
        .getByText(/PID 51204/)
        .hover();
      await page.waitForTimeout(900);
      return dialog;
    },
  },
  {
    name: "leftover-hover",
    capture: async (page, theme) => {
      const dialog = await populated(page, theme);
      // A closed terminal's leftovers: each process and its PID on hover.
      await dialog.getByText(/^3 processes still running/).hover();
      await page.waitForTimeout(900);
      return dialog;
    },
  },
  {
    name: "confirm-dev-server",
    capture: async (page, theme) => {
      const dialog = await populated(page, theme);
      await dialog.locator('[data-process-kill="dev-web"]').click();
      const confirm = page.locator(CONFIRM);
      await expect(confirm).toBeVisible({ timeout: ATTACH_TIMEOUT_MS });
      await page.waitForTimeout(600);
      return page.locator(CARD).last();
    },
  },
  {
    name: "confirm-terminal",
    capture: async (page, theme) => {
      const dialog = await populated(page, theme);
      await dialog.locator('[data-process-kill="claude-main"]').click();
      const confirm = page.locator(CONFIRM);
      await expect(confirm).toBeVisible({ timeout: ATTACH_TIMEOUT_MS });
      await page.waitForTimeout(600);
      return page.locator(CARD).last();
    },
  },
  {
    name: "confirm-closed",
    capture: async (page, theme) => {
      const dialog = await populated(page, theme);
      await dialog.locator("[data-process-kill^='closed:']").first().click();
      const confirm = page.locator(CONFIRM);
      await expect(confirm).toBeVisible({ timeout: ATTACH_TIMEOUT_MS });
      await page.waitForTimeout(600);
      return page.locator(CARD).last();
    },
  },
  {
    name: "degraded",
    capture: async (page, theme) => {
      const dialog = await load(page, theme, "degraded");
      await expect(dialog.locator('[data-testid="process-row"]').first()).toBeVisible();
      return dialog;
    },
  },
  {
    name: "empty",
    capture: async (page, theme) => {
      const dialog = await load(page, theme, "empty", 820);
      await expect(dialog.getByText(/no terminals|nothing/i).first()).toBeVisible();
      return dialog;
    },
  },
  {
    name: "loading",
    capture: async (page, theme) => {
      const dialog = await load(page, theme, "loading", 820);
      await page.waitForTimeout(500);
      return dialog;
    },
  },
];

test("processes dialog", async ({ browser }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PROCESSES is required for the processes dialog capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_PROCESSES=1 to capture");
  const context = await browser.newContext();
  await settleDevServer(context);
  const wanted = STATES.filter((s) => ONLY.length === 0 || ONLY.includes(s.name));
  let expected = 0;
  for (const state of wanted) {
    for (const theme of THEMES) {
      const page = await context.newPage();
      await stubViteHmrClient(page);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        const target = await state.capture(page, theme);
        if (errors.length > 0) throw new Error(`page threw: ${errors.join(" | ")}`);
        await snap(target, `${state.name}-${theme}.png`);
        expected++;
      } catch (error) {
        throw new Error(`${state.name}-${theme}: ${String(error)}`, { cause: error });
      } finally {
        await page.close().catch(() => undefined);
      }
    }
  }
  await context.close();
  const written = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(written.length).toBe(expected);
});
