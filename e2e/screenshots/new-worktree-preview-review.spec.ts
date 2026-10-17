/**
 * Create-worktree dialog visual-review harness, Vite edition.
 *
 * Renders the real `NewWorktreeDialog` through `new-worktree-preview.html`, with
 * its bridge calls answered from fixtures by
 * `src/components/Worktree/__preview__/newWorktreeBridge.ts`. Covers the states
 * the Electron harness (`worktree-dialog-review.spec.ts`) cannot reach on
 * demand: a branch list that hangs or fails, a PR whose head never arrives, a
 * project with no forge, recipes or environments. No build and no Electron.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_NEW_WORKTREE=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     npx playwright test --project=screenshots new-worktree-preview-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_NEW_WORKTREE  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR          output dir (default artifacts/new-worktree-shots)
 *   DAINTREE_SHOT_THEMES        theme sweep for the populated state
 *                               (default daintree,bondi,namib,hokkaido,redwoods,serengeti)
 *   DAINTREE_SHOT_ONLY          comma-separated state filter (the STATES names below);
 *                               the theme sweep runs only when it names the sweep state
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

const ENABLED = !!process.env.DAINTREE_SHOT_NEW_WORKTREE;
const OUT_DIR = path.resolve(
  process.env.DESIGN_CAPTURE_DIR ?? path.join(process.cwd(), "artifacts", "new-worktree-shots")
);
const THEMES = (
  process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib,hokkaido,redwoods,serengeti"
)
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ATTACH_TIMEOUT_MS = 30_000;
/** Entrance, the branch-list round trip and the 300ms path debounce. */
const OPEN_SETTLE_MS = 900;
const CLICK_TIMEOUT_MS = 5_000;

const snap = makeSnap(OUT_DIR);

test.use({ deviceScaleFactor: 2, actionTimeout: CLICK_TIMEOUT_MS });
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
  await page.goto(`${server!.baseURL}/new-worktree-preview.html`);
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const ready = await page.locator('[data-testid="new-worktree-dialog"]').count();
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
        console.warn(`[new-worktree-shots] renderer crashed on ${what}; retrying once`);
        continue;
      }
      throw new Error(`${what}: ${String(error)}`, { cause: error });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function open(page: Page, theme: string, query = ""): Promise<Locator> {
  await page.setViewportSize({ width: 1000, height: 1000 });
  await page.goto(`${server!.baseURL}/new-worktree-preview.html?theme=${theme}${query}`);
  const dialog = page.locator('[data-testid="new-worktree-dialog"]');
  await expect(dialog).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(OPEN_SETTLE_MS);
  return dialog;
}

const branchInput = (page: Page) => page.locator("#new-branch");

interface State {
  name: string;
  query?: string;
  run?: (page: Page) => Promise<void>;
  /** Text the capture must show, or it is a picture of the wrong state. */
  expectText?: string;
  /** Viewport rather than the dialog panel: a portalled popover sits outside it. */
  viewport?: boolean;
}

const typeBranch = async (page: Page, value: string) => {
  await branchInput(page).fill(value);
  await page.waitForTimeout(500);
};

const STATES: State[] = [
  { name: "10-rest", expectText: "Create worktree" },
  {
    name: "12-named",
    run: async (page) => {
      await typeBranch(page, "feature/retry-after-header");
      // Blur onto a static heading: Escape here would ask to discard the draft.
      await page.locator("h3", { hasText: "Destination" }).click({ force: true });
      await page.waitForTimeout(400);
    },
    expectText: "retry-after-header",
  },
  {
    name: "15-issue-agent",
    query: "&scenario=issue&agent=claude",
    expectText: "11958",
  },
  {
    name: "20-existing",
    run: async (page) => {
      await page
        .getByRole("radio", { name: "Existing branch" })
        .click({ timeout: CLICK_TIMEOUT_MS });
      await page.waitForTimeout(300);
    },
    expectText: "Select a local branch",
  },
  {
    name: "22-existing-picker",
    viewport: true,
    run: async (page) => {
      await page
        .getByRole("radio", { name: "Existing branch" })
        .click({ timeout: CLICK_TIMEOUT_MS });
      await page.locator("#existing-branch").click({ timeout: CLICK_TIMEOUT_MS });
      await page.waitForTimeout(400);
    },
  },
  {
    name: "24-existing-error",
    run: async (page) => {
      await page
        .getByRole("radio", { name: "Existing branch" })
        .click({ timeout: CLICK_TIMEOUT_MS });
      await page.getByTestId("create-worktree-button").click({ timeout: CLICK_TIMEOUT_MS });
      await page.waitForTimeout(400);
    },
  },
  {
    name: "26-mode-focus",
    run: async (page) => {
      // Back from the field below, so the ring is a keyboard one.
      await page.locator("#base-branch").focus();
      await page.keyboard.press("Shift+Tab");
      await page.waitForTimeout(300);
    },
  },
  {
    name: "30-base-picker",
    viewport: true,
    run: async (page) => {
      await page.locator("#base-branch").click({ timeout: CLICK_TIMEOUT_MS });
      await page.waitForTimeout(400);
    },
  },
  {
    name: "32-prefix-list",
    viewport: true,
    run: async (page) => {
      await branchInput(page).click();
      await branchInput(page).fill("f");
      await page.waitForTimeout(400);
    },
  },
  {
    name: "34-recipe-picker",
    viewport: true,
    run: async (page) => {
      await page.locator("#recipe-selector-trigger").click({ timeout: CLICK_TIMEOUT_MS });
      await page.waitForTimeout(400);
    },
  },
  {
    name: "36-agent-picker",
    viewport: true,
    run: async (page) => {
      await page.locator("#first-agent-selector-trigger").click({ timeout: CLICK_TIMEOUT_MS });
      await page.waitForTimeout(400);
    },
  },
  {
    name: "40-validation",
    run: async (page) => {
      await branchInput(page).fill("");
      await page.getByTestId("create-worktree-button").click({ timeout: CLICK_TIMEOUT_MS });
      await page.waitForTimeout(400);
    },
  },
  {
    name: "42-env-staging",
    run: async (page) => {
      await page.getByRole("radio", { name: "staging" }).click({ timeout: CLICK_TIMEOUT_MS });
      await page.waitForTimeout(300);
    },
    expectText: "staging",
  },
  {
    name: "44-keyboard-focus",
    run: async (page) => {
      await branchInput(page).focus();
      await page.keyboard.press("Shift+Tab");
      await page.waitForTimeout(300);
    },
  },
  { name: "50-loading", query: "&scenario=loading" },
  { name: "52-load-error", query: "&scenario=load-error", expectText: "Retry" },
  { name: "60-pr", query: "&scenario=pr", expectText: "12044" },
  { name: "62-pr-unresolved", query: "&scenario=pr-unresolved", expectText: "12044" },
  { name: "70-bare", query: "&scenario=bare" },
  {
    name: "80-discard-confirm",
    viewport: true,
    run: async (page) => {
      await typeBranch(page, "feature/retry-after-header");
      await page.locator("h3", { hasText: "Destination" }).click({ force: true });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
    },
    expectText: "Discard",
  },
];

/** The state the theme sweep re-shoots: the fullest the form gets. */
const SWEEP_STATE = "15-issue-agent";

async function shoot(page: Page, dialog: Locator, state: State, file: string) {
  console.log(`[new-worktree-shots] ${file}`);
  await state.run?.(page);
  const target = state.viewport ? page.locator("body") : dialog.locator("> div").first();
  if (state.expectText) {
    await expect(page.locator("body"), `${state.name} is not the state it names`).toContainText(
      state.expectText
    );
  }
  return snap(target, file);
}

test("new worktree dialog preview — every state, theme sweep", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_NEW_WORKTREE is required for the new worktree capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_NEW_WORKTREE=1 to run the capture");
  test.setTimeout(10 * 60_000);

  const unknown = ONLY.filter((name) => !STATES.some((s) => s.name === name));
  expect(unknown, "DAINTREE_SHOT_ONLY names states that do not exist").toEqual([]);

  await settleDevServer(context);
  const written: string[] = [];

  for (const state of STATES.filter((s) => ONLY.length === 0 || ONLY.includes(s.name))) {
    written.push(
      await withPage(context, `${state.name} daintree`, async (page) => {
        const dialog = await open(page, "daintree", state.query);
        return shoot(page, dialog, state, `${state.name}-daintree.png`);
      })
    );
  }

  const sweep = STATES.find((s) => s.name === SWEEP_STATE)!;
  const sweepThemes = ONLY.length === 0 || ONLY.includes(SWEEP_STATE) ? THEMES : [];
  for (const theme of sweepThemes.filter((t) => t !== "daintree")) {
    written.push(
      await withPage(context, `${sweep.name} ${theme}`, async (page) => {
        const dialog = await open(page, theme, sweep.query);
        return shoot(page, dialog, sweep, `${sweep.name}-${theme}.png`);
      })
    );
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  console.log(`[new-worktree-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
