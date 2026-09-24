/**
 * Update-working-directory dialog visual-review harness.
 *
 * Drives `update-cwd-preview.html`, which mounts the real `UpdateCwdDialog`
 * against the real panel store with the directory check and the restart
 * answered from query parameters. Every error state is reached the way a user
 * reaches it — typing into the field and submitting — so the pixels are the
 * product's own submit path, not a prop forced from outside.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_UPDATE_CWD=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots update-cwd-dialog-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_UPDATE_CWD  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR         output directory (default artifacts/update-cwd-shots)
 *   DAINTREE_SHOT_THEMES      comma-separated theme sweep (default daintree,bondi,namib,redwoods)
 *
 * Output:
 *   <state>-<theme>.png       the dialog card, every state in every theme
 *   rest-<theme>-window.png   the whole window with the scrim, first theme only
 *   rest-<theme>-focus.png    keyboard focus moved off the field, first theme only
 *   long-<theme>-narrow.png   the long path in a 520px window, first theme only
 *
 * Never writes a PNG it has not verified, and counts the files itself at the end.
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

const ENABLED = !!process.env.DAINTREE_SHOT_UPDATE_CWD;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "update-cwd-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib,redwoods")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const WIDTH = 1280;
const HEIGHT = 800;
const NARROW_WIDTH = 520;
const ATTACH_TIMEOUT_MS = 30_000;

const DIALOG = '[role="dialog"], [role="alertdialog"]';
const CARD = '[role="dialog"] > div, [role="alertdialog"] > div';

const TYPO_PATH = "/Users/greg/Projects/daintree-worktrees/fix-auth-refrsh";

const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

interface StateSpec {
  name: string;
  query: string;
  /** Drives the dialog into the state; returns what must be visible before the frame is taken. */
  act?: (page: Page, card: Locator) => Promise<string | null>;
}

async function submitTyped(page: Page, card: Locator, value: string) {
  const field = card.locator('input[type="text"]').first();
  await field.fill(value);
  await field.press("Enter");
}

const STATES: StateSpec[] = [
  { name: "rest", query: "cwd=short" },
  { name: "long", query: "cwd=long" },
  {
    name: "missing",
    query: "cwd=short&check=missing",
    act: async (page, card) => {
      await submitTyped(page, card, TYPO_PATH);
      return '[role="alert"]';
    },
  },
  {
    name: "empty",
    query: "cwd=short",
    act: async (page, card) => {
      await submitTyped(page, card, "");
      return '[role="alert"]';
    },
  },
  {
    name: "validating",
    query: "cwd=short&check=hang",
    act: async (page, card) => {
      await submitTyped(page, card, "/Users/greg/Projects/daintree");
      return 'button[disabled], button[aria-busy="true"]';
    },
  },
  {
    name: "restart-failed",
    query: "cwd=short&restart=fail",
    act: async (page, card) => {
      await submitTyped(page, card, "/Users/greg/Projects/daintree");
      return '[role="alert"]';
    },
  },
];

test.use({ deviceScaleFactor: 2 });

const snap = makeSnap(OUT_DIR);
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

/** Hold a throwaway page open until Vite's dependency optimizer stops reloading it. */
async function settleDevServer(context: BrowserContext) {
  const page = await context.newPage();
  await stubViteHmrClient(page);
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  await page.goto(`${server!.baseURL}/update-cwd-preview.html`);
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const dialogs = await page.locator(DIALOG).count();
    if (navigations === before && dialogs === 1) break;
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
        console.warn(`[update-cwd-shots] renderer crashed on ${what}; retrying once`);
        continue;
      }
      throw new Error(`${what}: ${String(error)}`, { cause: error });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function openState(page: Page, state: StateSpec, theme: string, width = WIDTH) {
  await page.setViewportSize({ width, height: HEIGHT });
  await page.goto(`${server!.baseURL}/update-cwd-preview.html?theme=${theme}&${state.query}`);
  await page.addStyleTag({ content: FREEZE_CSS });
  const card = page.locator(CARD).first();
  await expect(card, `state "${state.name}" opened no dialog`).toBeVisible({
    timeout: ATTACH_TIMEOUT_MS,
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const title = (await card.locator("h2").first().textContent())?.trim() ?? "";
  if (!title) throw new Error(`state "${state.name}" rendered an empty title`);
  if (state.act) {
    const mustSee = await state.act(page, card);
    if (mustSee) {
      await expect(
        card.locator(mustSee).first(),
        `state "${state.name}" never reached its target`
      ).toBeVisible({ timeout: 5_000 });
    }
    await page.waitForTimeout(200);
  }
  return card;
}

test("update-cwd dialog — every state, every theme", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_UPDATE_CWD is required for the update-cwd capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_UPDATE_CWD=1 to run the capture");

  await settleDevServer(context);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const state of STATES) {
      written.push(
        await withPage(context, `${state.name} ${theme}`, async (page) =>
          snap(await openState(page, state, theme), `${state.name}-${theme}.png`)
        )
      );
    }
  }

  const theme = THEMES[0]!;
  const rest = STATES[0]!;
  const long = STATES[1]!;
  written.push(
    await withPage(context, "window", async (page) => {
      await openState(page, rest, theme);
      return snap(page.locator("[data-preview-shell]"), `rest-${theme}-window.png`);
    })
  );
  written.push(
    await withPage(context, "focus", async (page) => {
      const card = await openState(page, rest, theme);
      await page.keyboard.press("Tab");
      await page.waitForTimeout(150);
      return snap(card, `rest-${theme}-focus.png`);
    })
  );
  written.push(
    await withPage(context, "narrow", async (page) =>
      snap(await openState(page, long, theme, NARROW_WIDTH), `long-${theme}-narrow.png`)
    )
  );

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * STATES.length + 3);
  console.log(`[update-cwd-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
