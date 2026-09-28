/**
 * Dialog chrome and destructive-confirmation visual-review harness.
 *
 * One sweep across the dialogs that share `AppDialog`'s footer, title and close
 * behaviour, and the destructive actions that should all be confirmed the same
 * way. Every state renders the product's real component through a Vite preview
 * page — `dialog-confirmations-preview.html` for the archive install confirm,
 * the file close guard and the non-git folder dialog, and the sibling preview
 * pages for the clone, git-init, create-folder, command builder, update-cwd,
 * toolbar settings and trash surfaces. No build and no Electron.
 *
 * The busy states hold their async call open, so the capture shows what the
 * chrome does while an action runs — which is where the close button used to
 * disappear.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_DIALOG_CONFIRM=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     npx playwright test --project=screenshots dialog-confirmations-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_DIALOG_CONFIRM  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR            output directory (default artifacts/dialog-confirmations-shots)
 *   DAINTREE_SHOT_THEMES          comma-separated theme sweep (default: daintree,bondi,namib)
 *   DAINTREE_SHOT_ONLY            comma-separated state filter
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

const ENABLED = !!process.env.DAINTREE_SHOT_DIALOG_CONFIRM;
const OUT_DIR = path.resolve(
  process.env.DESIGN_CAPTURE_DIR ??
    path.join(process.cwd(), "artifacts", "dialog-confirmations-shots")
);
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

const ATTACH_TIMEOUT_MS = 30_000;
const MODAL = 'div[aria-modal="true"]';
/** The card itself — the modal's only child. */
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
        console.warn(`[dialog-confirmations-shots] renderer crashed on ${what}; retrying once`);
        continue;
      }
      throw new Error(`${what}: ${String(error)}`, { cause: error });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function load(page: Page, url: string, width = 1000, height = 820): Promise<void> {
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

interface State {
  name: string;
  /** Page to settle the dev server against before the first capture of it. */
  page: string;
  capture: (page: Page, theme: string) => Promise<Locator>;
}

const STATES: State[] = [
  {
    name: "archive-rest",
    page: "dialog-confirmations-preview.html",
    capture: async (page, theme) => {
      await load(page, `dialog-confirmations-preview.html?theme=${theme}&state=archive`);
      const c = await card(page);
      // Past the confirm's read-time cooldown.
      await page.waitForTimeout(1_400);
      return c;
    },
  },
  {
    name: "archive-busy",
    page: "dialog-confirmations-preview.html",
    capture: async (page, theme) => {
      await load(page, `dialog-confirmations-preview.html?theme=${theme}&state=archive`);
      const c = await card(page);
      await page.waitForTimeout(1_400);
      await c.getByRole("button", { name: "Install plugin" }).click();
      // Past the button's spinner gate, so the busy state is what's on screen.
      await page.waitForTimeout(600);
      return c;
    },
  },
  {
    name: "close-guard",
    page: "dialog-confirmations-preview.html",
    capture: async (page, theme) => {
      await load(page, `dialog-confirmations-preview.html?theme=${theme}&state=close-guard`);
      const c = await card(page);
      await expect(c.getByText("retry-backoff.ts", { exact: false })).toBeVisible();
      return c;
    },
  },
  {
    name: "close-guard-busy",
    page: "dialog-confirmations-preview.html",
    capture: async (page, theme) => {
      await load(page, `dialog-confirmations-preview.html?theme=${theme}&state=close-guard`);
      const c = await card(page);
      await c.getByRole("button", { name: /^save$/i }).click();
      await page.waitForTimeout(600);
      return c;
    },
  },
  {
    name: "non-git",
    page: "dialog-confirmations-preview.html",
    capture: async (page, theme) => {
      await load(page, `dialog-confirmations-preview.html?theme=${theme}&state=non-git`);
      return card(page);
    },
  },
  {
    name: "clone-configure",
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
      return c;
    },
  },
  {
    name: "clone-running",
    page: "clone-dialog-preview.html",
    capture: async (page, theme) => {
      await load(page, `clone-dialog-preview.html?theme=${theme}&outcome=hang`);
      const c = await card(page);
      await page
        .locator("#clone-repo-url")
        .fill("https://github.com/helios-labs/helios-dashboard.git");
      await page
        .getByRole("button", { name: /browse|choose/i })
        .first()
        .click();
      await page.waitForTimeout(300);
      await page
        .getByRole("button", { name: /^clone/i })
        .last()
        .click();
      await page.evaluate(() => {
        const shot = Reflect.get(window, "__cloneShot") as {
          emit: (e: unknown) => void;
        };
        shot.emit({ stage: "receiving objects", progress: 64, message: "Receiving objects: 64%" });
      });
      await page.waitForTimeout(500);
      return c;
    },
  },
  {
    name: "git-init",
    page: "clone-dialog-preview.html",
    capture: async (page, theme) => {
      await load(page, `clone-dialog-preview.html?theme=${theme}&dialog=git-init`);
      return card(page);
    },
  },
  {
    name: "create-folder",
    page: "clone-dialog-preview.html",
    capture: async (page, theme) => {
      await load(page, `clone-dialog-preview.html?theme=${theme}&dialog=create-folder`);
      return card(page);
    },
  },
  {
    name: "picker-load-error",
    page: "command-builder-preview.html",
    capture: async (page, theme) => {
      await load(page, `command-builder-preview.html?theme=${theme}&host=load-error`);
      return card(page);
    },
  },
  {
    name: "builder-enter",
    page: "command-builder-preview.html",
    capture: async (page, theme) => {
      // What Enter in a text field does: the builder should submit, as every
      // other form dialog does.
      await load(
        page,
        `command-builder-preview.html?theme=${theme}&fixture=create-issue&outcome=pending`
      );
      const c = await card(page);
      const title = c.getByRole("textbox").first();
      await title.fill("Command builder loses focus on Execute");
      await title.press("Enter");
      await page.waitForTimeout(500);
      return c;
    },
  },
  {
    name: "builder-success",
    page: "command-builder-preview.html",
    capture: async (page, theme) => {
      await load(page, `command-builder-preview.html?theme=${theme}&fixture=create-issue`);
      const c = await card(page);
      await c.getByRole("textbox").first().fill("Command builder loses focus on Execute");
      await c.getByRole("button").last().click();
      await expect(page.locator("body[data-executed-args]")).toBeAttached();
      await page.waitForTimeout(500);
      return c;
    },
  },
  {
    name: "update-cwd",
    page: "update-cwd-preview.html",
    capture: async (page, theme) => {
      await load(page, `update-cwd-preview.html?theme=${theme}`);
      return card(page);
    },
  },
  {
    name: "toolbar-reset",
    page: "toolbar-settings-preview.html",
    capture: async (page, theme) => {
      // What pressing Reset does: every sibling reset in Settings confirms first.
      await load(page, `toolbar-settings-preview.html?theme=${theme}&fixture=populated`, 1000, 900);
      const reset = page.getByRole("button", { name: /reset toolbar/i }).last();
      await reset.scrollIntoViewIfNeeded();
      await reset.click();
      await page.waitForTimeout(600);
      return page.locator("body");
    },
  },
  {
    name: "trash-row-confirm",
    page: "trash-preview.html",
    capture: async (page, theme) => {
      await load(page, `trash-preview.html?theme=${theme}&fixture=spread&width=1100`, 1100, 700);
      await page.locator('[data-testid="trash-container"]').click();
      const popover = page.locator('[role="dialog"][aria-label="Recently closed terminals"]');
      await expect(popover).toBeVisible({ timeout: ATTACH_TIMEOUT_MS });
      await page.waitForTimeout(350);
      await popover
        .locator("[data-trash-row]")
        .first()
        .getByRole("button", { name: /permanently/i })
        .click();
      return card(page);
    },
  },
];

test("dialog chrome and destructive confirmations", async ({ browser }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_DIALOG_CONFIRM is required for the dialog confirmations capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_DIALOG_CONFIRM=1 to run the dialog confirmations capture");
  test.setTimeout(20 * 60_000);

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
