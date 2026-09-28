/**
 * Validation-error, error-callout and warning-callout visual-review harness.
 *
 * One sweep across the places the product tells the user something went wrong
 * or needs care: worktree card banners, the missing-CLI gate, typed-name
 * confirms, settings load and field errors, plugin manager errors, the archive
 * install danger callout, system requirements, the push-destination callout,
 * crash recovery, the lifecycle approval load error, the new-worktree
 * validation and PR warnings, the MCP destructive consequence note, and the
 * per-field errors in the project, update-cwd and command builder dialogs.
 *
 * Every state renders the product's real component through a Vite preview page
 * — `errors-callouts-preview.html` for most, and the sibling clone-dialog,
 * update-cwd and command-builder pages for the dialog field errors, driven by
 * typing into them. No build and no Electron. Each capture first asserts a
 * string that only the error state puts on screen, so a green run never leaves
 * behind a picture of the happy path.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_ERRORS_CALLOUTS=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     npx playwright test --project=screenshots errors-callouts-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_ERRORS_CALLOUTS  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR             output directory (default artifacts/errors-callouts-shots)
 *   DAINTREE_SHOT_THEMES           comma-separated theme sweep (default: daintree,bondi)
 *   DAINTREE_SHOT_ONLY             comma-separated state filter
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

const ENABLED = !!process.env.DAINTREE_SHOT_ERRORS_CALLOUTS;
const OUT_DIR = path.resolve(
  process.env.DESIGN_CAPTURE_DIR ?? path.join(process.cwd(), "artifacts", "errors-callouts-shots")
);
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

const ATTACH_TIMEOUT_MS = 30_000;
const PAGE = "errors-callouts-preview.html";
const MODAL = 'div[aria-modal="true"]';
/** The card itself — the modal's only child. */
const CARD = `${MODAL} > div`;
const SCENE = '[data-testid="scene"]';

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
async function settleDevServer(context: BrowserContext, url: string) {
  const page = await context.newPage();
  await stubViteHmrClient(page);
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  await page.goto(`${server!.baseURL}/${url}`);
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const ready = await page.locator("#root > *").count();
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
        console.warn(`[errors-callouts-shots] renderer crashed on ${what}; retrying once`);
        continue;
      }
      throw new Error(`${what}: ${String(error)}`, { cause: error });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function load(page: Page, url: string, width = 1000, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto(`${server!.baseURL}/${url}`);
  await expect(page.locator("#root > *").first()).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready);
}

/** Wait for a dialog card, past its entrance and the focus handoff after it. */
async function card(page: Page): Promise<Locator> {
  const found = page.locator(CARD).last();
  await expect(found).toBeVisible({ timeout: ATTACH_TIMEOUT_MS });
  await page.waitForTimeout(450);
  return found;
}

/** Load an inline scene of this page and return its root. */
async function scene(page: Page, state: string, theme: string, height = 900): Promise<Locator> {
  await load(page, `${PAGE}?theme=${theme}&state=${state}`, 1280, height);
  const root = page.locator(SCENE);
  await expect(root).toBeVisible({ timeout: ATTACH_TIMEOUT_MS });
  return root;
}

/** Every string must be on screen inside `within`, or the capture is refused. */
async function mustShow(within: Locator, ...texts: (string | RegExp)[]): Promise<void> {
  for (const text of texts) {
    await expect(within.getByText(text).first()).toBeVisible({ timeout: ATTACH_TIMEOUT_MS });
  }
}

interface State {
  name: string;
  /** Page to settle the dev server against before the first capture of it. */
  page: string;
  capture: (page: Page, theme: string) => Promise<Locator>;
}

const STATES: State[] = [
  {
    name: "worktree-banners",
    page: PAGE,
    capture: async (page, theme) => {
      const root = await scene(page, "worktree-banners", theme);
      await mustShow(
        root,
        "Couldn't delete worktree",
        "hint:   git worktree remove --force feature-auth-refresh",
        "Couldn't attach issue",
        "Couldn't unlink issue"
      );
      return root;
    },
  },
  {
    name: "missing-cli",
    page: PAGE,
    capture: async (page, theme) => {
      const root = await scene(page, "missing-cli", theme);
      await root
        .locator('[data-specimen="recheck-failed"]')
        .getByRole("button", { name: /re-check/i })
        .click();
      await mustShow(
        root,
        "CLI binary not found",
        "CLI installed but not directly launchable",
        "Blocked by security software",
        "Couldn't re-check the CLI"
      );
      await page.waitForTimeout(400);
      return root;
    },
  },
  {
    name: "typed-name",
    page: PAGE,
    capture: async (page, theme) => {
      const root = await scene(page, "typed-name", theme);
      await expect(
        root.locator('[data-specimen="typed-mismatch"] input[aria-invalid="true"]')
      ).toHaveValue("helios-dash");
      await mustShow(root, "helios-dashboard");
      return root;
    },
  },
  {
    name: "settings-load-error",
    page: PAGE,
    capture: async (page, theme) => {
      const root = await scene(page, "settings-load-error", theme);
      await mustShow(
        root,
        "Couldn't load agent settings",
        "The settings store didn't answer in time.",
        "Port must be between 1024 and 65535",
        /already bound to Open command palette/
      );
      return root;
    },
  },
  {
    name: "plugin-errors",
    page: PAGE,
    capture: async (page, theme) => {
      const root = await scene(page, "plugin-errors", theme, 1200);
      const mcp = root.locator('[data-specimen="mcp"]');
      await mustShow(mcp, /LINEAR_API_KEY is not set/);
      // The crashed row's restart rejects, leaving the row's own error.
      await mcp
        .getByRole("button", { name: /restart server/i })
        .first()
        .click();
      await mustShow(
        root,
        /Couldn't read this plugin's log buffer/,
        /was unloaded while restarting/,
        // The next 3s poll fails, which leaves the section error under the list.
        /plugin-mcp:list timed out/,
        "Unreadable",
        /contributes\.commands\[2\]\.id/,
        /activate\(\) threw/,
        /An installed plugin already uses this id/,
        /EMFILE, too many open files/
      );
      await page.waitForTimeout(300);
      return root;
    },
  },
  {
    name: "system-requirements",
    page: PAGE,
    capture: async (page, theme) => {
      const root = await scene(page, "system-requirements", theme, 1100);
      const failed = root.locator('[data-specimen="health-error"]');
      // A spec-read failure is not fatal, so the panel starts folded.
      await failed.getByRole("button", { name: /system requirements/i }).click();
      await mustShow(
        root,
        /Could not run health check: system:get-health-check-specs timed out/,
        "Install Git using the steps above, then check again.",
        /Update Node\.js to v18\.0\.0 or later/
      );
      await page.waitForTimeout(500);
      return root;
    },
  },
  {
    name: "archive-install",
    page: PAGE,
    capture: async (page, theme) => {
      await load(page, `${PAGE}?theme=${theme}&state=archive-install`);
      const c = await card(page);
      await mustShow(c, "Can run arbitrary commands on your machine");
      // Past the confirm's read-time cooldown, then the install fails.
      await page.waitForTimeout(1_400);
      await c.getByRole("button", { name: "Install plugin" }).click();
      await mustShow(c, /declares engine \^3\.0\.0/);
      await page.waitForTimeout(300);
      return c;
    },
  },
  {
    name: "commit-push",
    page: PAGE,
    capture: async (page, theme) => {
      await load(page, `${PAGE}?theme=${theme}&state=commit-push`);
      await page
        .getByRole("button", { name: /commit & push/i })
        .first()
        .click();
      const c = await card(page);
      await mustShow(c, /No push destination is configured for this branch/);
      return c;
    },
  },
  {
    name: "crash-recovery",
    page: PAGE,
    capture: async (page, theme) => {
      await load(page, `${PAGE}?theme=${theme}&state=crash-recovery`, 1000, 1400);
      const c = await card(page);
      await c.locator('[data-testid="details-toggle"]').click();
      await mustShow(c, "Recovery failed", /Maximum call stack size exceeded/);
      await page.waitForTimeout(300);
      return c;
    },
  },
  {
    name: "crash-report-error",
    page: PAGE,
    capture: async (page, theme) => {
      await load(page, `${PAGE}?theme=${theme}&state=crash-report-error`, 1000, 1400);
      const c = await card(page);
      await c.locator('[data-testid="details-toggle"]').click();
      await c.locator('[data-testid="report-button"]').click();
      await c.locator('[data-testid="submit-report-button"]').click();
      const error = c.locator('[data-testid="report-error"]');
      await expect(error).toBeVisible({ timeout: ATTACH_TIMEOUT_MS });
      await error.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      return c;
    },
  },
  {
    name: "lifecycle-approval",
    page: PAGE,
    capture: async (page, theme) => {
      await load(page, `${PAGE}?theme=${theme}&state=lifecycle-approval`);
      const c = await card(page);
      await mustShow(c, /Unexpected token '\}' at line 14/);
      return c;
    },
  },
  {
    name: "new-worktree-error",
    page: PAGE,
    capture: async (page, theme) => {
      await load(page, `${PAGE}?theme=${theme}&state=new-worktree-error`, 1000, 1000);
      const c = await card(page);
      await mustShow(c, /Failed to load branches: git branch -a exited with code 128/);
      return c;
    },
  },
  {
    name: "new-worktree-pr",
    page: PAGE,
    capture: async (page, theme) => {
      await load(page, `${PAGE}?theme=${theme}&state=new-worktree-pr`, 1000, 1000);
      const c = await card(page);
      await mustShow(c, /Could not fetch branch/);
      return c;
    },
  },
  {
    name: "mcp-confirm-destructive",
    page: PAGE,
    capture: async (page, theme) => {
      await load(page, `${PAGE}?theme=${theme}&state=mcp-confirm-destructive`, 1000, 1000);
      const c = await card(page);
      await mustShow(c, "What this does", /2 local commits are not on any remote/);
      await page.waitForTimeout(1_000);
      return c;
    },
  },
  {
    name: "clone-name-error",
    page: "clone-dialog-preview.html",
    capture: async (page, theme) => {
      await load(page, `clone-dialog-preview.html?theme=${theme}`);
      const c = await card(page);
      await page
        .locator("#clone-repo-url")
        .fill("https://github.com/helios-labs/helios-dashboard.git");
      await page
        .getByRole("button", { name: /browse|choose/i })
        .first()
        .click();
      await page.waitForTimeout(300);
      await page.locator("#clone-folder-name").fill("bad/name");
      await mustShow(c, "Folder name must not contain path separators");
      await page.waitForTimeout(300);
      return c;
    },
  },
  {
    name: "create-folder-error",
    page: "clone-dialog-preview.html",
    capture: async (page, theme) => {
      await load(page, `clone-dialog-preview.html?theme=${theme}&dialog=create-folder`);
      const c = await card(page);
      await page.locator("#create-folder-name").fill("bad/name");
      await mustShow(c, "Folder name must not contain path separators");
      await page.waitForTimeout(300);
      return c;
    },
  },
  {
    name: "git-init-missing",
    page: "clone-dialog-preview.html",
    capture: async (page, theme) => {
      await load(page, `clone-dialog-preview.html?theme=${theme}&dialog=git-init`);
      const c = await card(page);
      await page.locator("#git-init-project-name").fill("");
      await mustShow(c, "Enter a project name");
      await page.waitForTimeout(300);
      return c;
    },
  },
  {
    name: "update-cwd-error",
    page: "update-cwd-preview.html",
    capture: async (page, theme) => {
      await load(page, `update-cwd-preview.html?theme=${theme}&cwd=short`);
      const c = await card(page);
      const field = page.locator("#new-cwd-input");
      await field.fill("/Users/greg/Projects/daintree-worktrees/fix-auth-refrsh");
      await field.press("Enter");
      await mustShow(c, "This folder doesn't exist. Check the path, or browse for one.");
      await page.waitForTimeout(300);
      return c;
    },
  },
  {
    name: "command-builder-error",
    page: "command-builder-preview.html",
    capture: async (page, theme) => {
      await load(page, `command-builder-preview.html?theme=${theme}&fixture=work-issue`);
      const c = await card(page);
      // Submit with the required issue number left empty.
      await c.getByRole("button").last().click();
      await mustShow(c, "Required to run this command");
      await page.waitForTimeout(300);
      return c;
    },
  },
  {
    name: "command-builder-exec-error",
    page: "command-builder-preview.html",
    capture: async (page, theme) => {
      await load(
        page,
        `command-builder-preview.html?theme=${theme}&fixture=create-issue&outcome=error`
      );
      const c = await card(page);
      await c.getByRole("textbox").first().fill("Command builder loses focus on Execute");
      await c.getByRole("button").last().click();
      await expect(page.locator("body[data-executed-args]")).toBeAttached({
        timeout: ATTACH_TIMEOUT_MS,
      });
      await mustShow(c, "Cannot reach GitHub. Check your internet connection.");
      await page.waitForTimeout(400);
      return c;
    },
  },
];

test("errors and callouts", async ({ browser }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_ERRORS_CALLOUTS is required for the errors and callouts capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_ERRORS_CALLOUTS=1 to run the errors and callouts capture");
  test.setTimeout(30 * 60_000);

  const states = STATES.filter((s) => ONLY.length === 0 || ONLY.includes(s.name));
  const context = await browser.newContext({ deviceScaleFactor: 2 });
  const settled = new Set<string>();
  const written: string[] = [];

  for (const state of states) {
    if (!settled.has(state.page)) {
      await settleDevServer(context, state.page);
      settled.add(state.page);
    }
    for (const theme of THEMES) {
      written.push(
        await withPage(context, `${state.name}/${theme}`, async (page) => {
          const target = await state.capture(page, theme);
          return snap(target, `${state.name}-${theme}.png`);
        })
      );
    }
  }
  await context.close();

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(states.length * THEMES.length);
  expect(new Set(written).size).toBe(written.length);
});
