/**
 * Plugin prompt dialogs visual-review harness.
 *
 * Renders the real `PluginQuickPickDialog`, `PluginInputBoxDialog` and
 * `PluginConfirmPromptDialog` through `plugin-prompt-preview.html`, with each
 * request pushed through `pluginPromptStore.enqueue` — the seam the IPC
 * listener feeds. No build and no Electron.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_PLUGIN_PROMPT=1 npx playwright test --project=screenshots plugin-prompt-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PLUGIN_PROMPT  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR            output directory (default artifacts/plugin-prompt-shots)
 *   DAINTREE_SHOT_THEMES         comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Output: <state>-<theme>.png. Each capture is clipped to the surface plus a
 * margin so the shadow and the scrim behind it are judged too. The test counts
 * the files itself rather than trusting its own exit code.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_PLUGIN_PROMPT;
const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "plugin-prompt-shots")
);
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const ATTACH_TIMEOUT_MS = 30_000;
const CLIP_PAD = 32;
/** The palette surface, or the card inside the dialog's full-window backdrop. */
const SURFACE = '[aria-modal="true"][tabindex="-1"], [aria-modal="true"] > div[tabindex="-1"]';
const MOD = process.platform === "darwin" ? "Meta" : "Control";

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

async function settleDevServer(context: BrowserContext) {
  const page = await context.newPage();
  await stubViteHmrClient(page);
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  await page.goto(`${server!.baseURL}/plugin-prompt-preview.html?fixture=qp-basic`);
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const ready = await page.locator(SURFACE).count();
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
        console.warn(`[plugin-prompt-shots] renderer crashed on ${what}; retrying once`);
        continue;
      }
      throw new Error(`${what}: ${String(error)}`, { cause: error });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function open(page: Page, theme: string, fixture: string): Promise<Locator> {
  await page.setViewportSize({ width: 1000, height: 760 });
  await page.goto(
    `${server!.baseURL}/plugin-prompt-preview.html?theme=${theme}&fixture=${fixture}`
  );
  const surface = page.locator(SURFACE).first();
  await expect(surface).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready);
  // Palette entrance is 150ms, dialog 200ms; the focus handoff is a frame later.
  await page.waitForTimeout(450);
  return surface;
}

/** Clip to the surface plus a margin, refusing to write a frame with no real box. */
async function snap(page: Page, surface: Locator, file: string): Promise<string> {
  await page.waitForTimeout(250);
  const box = await surface.boundingBox();
  if (!box || box.width < 80 || box.height < 40) {
    throw new Error(
      `${file}: surface has no real box (${JSON.stringify(box)}) — refusing to write`
    );
  }
  const viewport = page.viewportSize()!;
  const x = Math.max(0, box.x - CLIP_PAD);
  const y = Math.max(0, box.y - CLIP_PAD);
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    animations: "disabled",
    caret: "hide",
    clip: {
      x,
      y,
      width: Math.min(box.width + CLIP_PAD * 2, viewport.width - x),
      height: Math.min(box.height + CLIP_PAD * 2, viewport.height - y),
    },
  });
  return out;
}

/**
 * Type into the input box's field. Clicked rather than assumed focused, so a
 * state still captures when the dialog's own initial focus is wrong — that is
 * judged from the rest captures, not by breaking this one.
 */
async function typeInField(page: Page, text: string): Promise<void> {
  await page.locator('[aria-modal="true"] input').first().click();
  await page.keyboard.type(text);
}

interface State {
  name: string;
  fixture: string;
  run?: (page: Page) => Promise<void>;
  /** Text the capture must show, or it is a picture of the wrong state. */
  expectText?: string;
}

const STATES: State[] = [
  { name: "10-qp-basic", fixture: "qp-basic", expectText: "Choose a branch to release" },
  {
    name: "12-qp-basic-cursor",
    fixture: "qp-basic",
    run: async (page) => {
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
    },
    expectText: "release/2.4",
  },
  { name: "14-qp-defaults", fixture: "qp-defaults", expectText: "Select an option" },
  { name: "20-qp-rich", fixture: "qp-rich", expectText: "Last deployed 2 hours ago" },
  {
    name: "22-qp-rich-filtered",
    fixture: "qp-rich",
    run: async (page) => {
      await page.keyboard.type("east");
    },
    expectText: "Staging",
  },
  {
    name: "24-qp-no-match",
    fixture: "qp-rich",
    run: async (page) => {
      await page.keyboard.type("kubernetes");
    },
    expectText: "kubernetes",
  },
  { name: "26-qp-long", fixture: "qp-long", expectText: "Rollback" },
  { name: "30-qp-multi-none", fixture: "qp-multi", expectText: "Run which checks" },
  {
    name: "32-qp-multi-checked",
    fixture: "qp-multi",
    run: async (page) => {
      await page.keyboard.press("Enter");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.keyboard.press("ArrowDown");
    },
    expectText: "Unit tests",
  },
  { name: "40-qp-empty", fixture: "qp-empty", expectText: "Release Helper" },
  { name: "50-ib-full", fixture: "ib-full", expectText: "Name the release" },
  { name: "52-ib-prefilled", fixture: "ib-prefilled" },
  { name: "54-ib-defaults", fixture: "ib-defaults", expectText: "Enter a value" },
  {
    name: "56-ib-password",
    fixture: "ib-password",
    run: async (page) => {
      await typeInField(page, "ghp_notarealtoken0123456789");
    },
    expectText: "Release Helper",
  },
  {
    name: "60-ib-invalid",
    fixture: "ib-invalid",
    run: async (page) => {
      await typeInField(page, "2.5 final");
      await page.keyboard.press("Enter");
    },
    expectText: "Use a semver tag like v2.5.0",
  },
  {
    name: "62-ib-invalid-typing",
    fixture: "ib-invalid",
    run: async (page) => {
      await typeInField(page, "2.5 final");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Backspace");
    },
  },
  {
    name: "64-ib-invalid-default",
    fixture: "ib-invalid-default",
    run: async (page) => {
      await typeInField(page, "1234");
      await page.keyboard.press("Enter");
    },
  },
  { name: "66-ib-long", fixture: "ib-long", expectText: "CHANGELOG.md" },
  { name: "68-ib-spoof-name", fixture: "ib-spoof", expectText: "safe to paste secrets into" },
  { name: "80-cf-default", fixture: "cf-default", expectText: "Publish release v2.5.0?" },
  { name: "82-cf-destructive", fixture: "cf-destructive", expectText: "Delete tag" },
];

test("plugin prompt dialogs — every state, every theme", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PLUGIN_PROMPT is required for the plugin prompt capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_PLUGIN_PROMPT=1 to run the capture");
  test.setTimeout(15 * 60_000);

  await settleDevServer(context);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const state of STATES) {
      written.push(
        await withPage(context, `${state.name} ${theme}`, async (page) => {
          const surface = await open(page, theme, state.fixture);
          await state.run?.(page);
          if (state.expectText) {
            await expect(surface, `${state.name} is not the state it names`).toContainText(
              state.expectText
            );
          }
          // A capture of a surface that already resolved is a picture of nothing.
          expect(await page.evaluate(() => Reflect.get(window, "__promptResult"))).toBeUndefined();
          return snap(page, surface, `${state.name}-${theme}.png`);
        })
      );
    }
  }

  // Behaviour the pictures cannot show. Focus first: the dialog's own
  // initial-focus pass only lands on its close button in a real browser, so
  // this is the check that a plugin prompt opens ready to type into.
  await withPage(context, "input focus", async (page) => {
    await open(page, THEMES[0]!, "ib-full");
    const focused = await page.evaluate(() => document.activeElement?.tagName ?? null);
    expect(focused).toBe("INPUT");
  });

  // And what the plugin actually receives.
  await withPage(context, "multi submit", async (page) => {
    await open(page, THEMES[0]!, "qp-multi");
    await page.keyboard.press("Enter");
    await page.keyboard.press(`${MOD}+Enter`);
    const result = await page.evaluate(() => Reflect.get(window, "__promptResult"));
    expect(result).toEqual([{ id: "lint", label: "Lint", description: "eslint + prettier" }]);
  });

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * STATES.length);
  console.log(`[plugin-prompt-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
