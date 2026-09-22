/**
 * Clone-repository dialog visual-review harness, Vite edition.
 *
 * Renders the real `CloneRepoDialog` through `clone-dialog-preview.html`, with
 * the five bridge calls it makes answered by `src/components/Project/__preview__`.
 * No build and no Electron, so a round of captures costs seconds rather than a
 * rebuild. `clone-dialog-review.spec.ts` remains the end-to-end version that
 * drives the real main-process path.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_CLONE_PREVIEW=1 npx playwright test --project=screenshots clone-dialog-preview-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_CLONE_PREVIEW  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR            output directory (default artifacts/clone-preview-shots)
 *   DAINTREE_SHOT_THEMES         comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Output: <state>-<theme>.png, one per state per theme. The test counts the
 * files itself rather than trusting its own exit code.
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

const ENABLED = !!process.env.DAINTREE_SHOT_CLONE_PREVIEW;
const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "clone-preview-shots")
);
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const ATTACH_TIMEOUT_MS = 30_000;
const CLONE_URL = "https://github.com/helios-labs/helios-dashboard.git";
const STAGES = [
  { stage: "counting objects", progress: 100, message: "Counting objects: 100%" },
  { stage: "compressing objects", progress: 100, message: "Compressing objects: 100%" },
  { stage: "receiving objects", progress: 64, message: "Receiving objects: 64%" },
];

const snap = makeSnap(OUT_DIR);

// Spacing and alignment are the whole question for a form; judge them at 2x.
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
  await page.goto(`${server!.baseURL}/clone-dialog-preview.html`);
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const ready = await page.locator("#clone-repo-url").count();
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
        console.warn(`[clone-preview-shots] renderer crashed on ${what}; retrying once`);
        continue;
      }
      throw new Error(`${what}: ${String(error)}`, { cause: error });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function open(page: Page, theme: string, query = ""): Promise<Locator> {
  await page.setViewportSize({ width: 1000, height: 820 });
  await page.goto(`${server!.baseURL}/clone-dialog-preview.html?theme=${theme}${query}`);
  const panel = page.locator('div[aria-modal="true"] > div').first();
  await expect(page.locator("#clone-repo-url")).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready);
  // Dialog entrance is 200ms; the focus handoff is one frame after open.
  await page.waitForTimeout(400);
  return panel;
}

async function fill(page: Page, url = CLONE_URL): Promise<void> {
  await page.locator("#clone-repo-url").fill(url);
  await page
    .getByRole("button", { name: /browse|choose/i })
    .first()
    .click();
  await page.waitForTimeout(200);
}

async function clickClone(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /^clone/i })
    .last()
    .click();
}

async function emit(page: Page, stages: typeof STAGES): Promise<void> {
  await page.evaluate((events) => {
    const shot = Reflect.get(window, "__cloneShot") as { emit: (e: unknown) => void };
    let tick = 1_700_000_000_000;
    for (const e of events) shot.emit({ ...e, timestamp: (tick += 1000) });
  }, stages);
}

interface State {
  name: string;
  query?: string;
  run: (page: Page) => Promise<void>;
  /** Text the capture must show, or it is a picture of the wrong state. */
  expectText?: string;
}

const STATES: State[] = [
  { name: "10-empty", run: async () => undefined },
  { name: "15-valid", run: (page) => fill(page), expectText: "helios-dashboard" },
  {
    name: "18-valid-no-focus",
    run: async (page) => {
      await fill(page);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    },
  },
  {
    name: "20-shorthand",
    run: (page) => fill(page, "helios-labs/helios-dashboard"),
    expectText: "helios-dashboard",
  },
  {
    name: "22-invalid-url",
    run: async (page) => {
      await fill(page);
      await page.locator("#clone-repo-url").fill("helios dashboard");
      await page.waitForTimeout(150);
    },
    expectText: "Use a repository URL or owner/repo",
  },
  {
    name: "25-validation-error",
    run: async (page) => {
      await fill(page);
      await page.locator("#clone-folder-name").fill("helios:dashboard");
      await page.waitForTimeout(150);
    },
  },
  {
    name: "28-shallow-checked",
    run: async (page) => {
      await fill(page);
      await page.getByText("Shallow clone", { exact: false }).first().click();
    },
  },
  {
    name: "30-connecting",
    query: "&outcome=hang",
    run: async (page) => {
      await fill(page);
      await clickClone(page);
      await page.waitForTimeout(700);
    },
    expectText: "Connecting",
  },
  {
    name: "35-progress",
    query: "&outcome=hang",
    run: async (page) => {
      await fill(page);
      await clickClone(page);
      await page.waitForTimeout(600);
      await emit(page, STAGES);
      await page.waitForTimeout(300);
    },
    expectText: "Receiving objects",
  },
  {
    name: "40-cancelled",
    query: "&outcome=hang",
    run: async (page) => {
      await fill(page);
      await clickClone(page);
      await page.waitForTimeout(600);
      await page.getByRole("button", { name: /stop clone/i }).click();
      await page.waitForTimeout(400);
    },
    expectText: "Clone stopped",
  },
  {
    name: "45-failure-auth",
    query: "&outcome=auth",
    run: async (page) => {
      await fill(page);
      await clickClone(page);
      await page.waitForTimeout(500);
    },
    expectText: "Sign in to GitHub",
  },
  {
    name: "50-failure-generic",
    query: "&outcome=error&providers=0",
    run: async (page) => {
      await fill(page);
      await clickClone(page);
      await page.waitForTimeout(500);
    },
    expectText: "Clone failed",
  },
  {
    name: "60-success",
    query: "&outcome=success",
    run: async (page) => {
      await fill(page);
      await clickClone(page);
      await page.waitForTimeout(500);
    },
    expectText: "Repository cloned",
  },
];

test("clone dialog preview — every state, every theme", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_CLONE_PREVIEW is required for the clone-dialog preview capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_CLONE_PREVIEW=1 to run the capture");
  test.setTimeout(10 * 60_000);

  await settleDevServer(context);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const state of STATES) {
      written.push(
        await withPage(context, `${state.name} ${theme}`, async (page) => {
          const panel = await open(page, theme, state.query);
          await state.run(page);
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
  console.log(`[clone-preview-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
