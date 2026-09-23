/**
 * First-run journey visual-review harness, Vite edition.
 *
 * Renders the welcome screen, the agent setup wizard and the getting-started
 * checklist through `first-run-preview.html`, composed the way the app composes
 * them, and walks the journey with real clicks: the banner opens the wizard, the
 * wizard's own buttons advance it, "Not now" and finishing write through the
 * onboarding IPC, and the app's gating picks what the canvas shows next. No build
 * and no Electron, so a round of captures costs seconds.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_FIRSTRUN=1 DAINTREE_SHOT_DIR=/tmp/first-run \
 *     ./node_modules/.bin/playwright test --project=screenshots first-run-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_FIRSTRUN  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR       output directory (required, outside the repo)
 *   DAINTREE_SHOT_THEMES    comma-separated theme sweep (default: daintree,bondi,namib)
 *   DAINTREE_SHOT_ONLY      comma-separated state-name prefixes to capture
 *
 * Output: <state>-<theme>.png. The test counts the files itself rather than
 * trusting its own exit code.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_FIRSTRUN;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ? path.resolve(process.env.DAINTREE_SHOT_DIR) : "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const LIGHT_THEMES = new Set(["bondi", "atacama", "svalbard"]);

const ATTACH_TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1280, height: 820 };
const WIZARD = '[data-testid="agent-setup-wizard"]';
const STEP = '[data-testid="agent-setup-step"]';

test.use({ deviceScaleFactor: 2 });
let server: PreviewServer | undefined;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!OUT_DIR) throw new Error("DAINTREE_SHOT_DIR is required — captures never go in the repo");
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
  await page.goto(`${server!.baseURL}/first-run-preview.html`);
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const ready = await page.locator("[data-preview-shell]").count();
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
        console.warn(`[first-run-shots] renderer crashed on ${what}; retrying once`);
        continue;
      }
      throw new Error(`${what}: ${String(error)}`, { cause: error });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function open(page: Page, theme: string, query: string): Promise<void> {
  await page.setViewportSize(VIEWPORT);
  await page.emulateMedia({ colorScheme: LIGHT_THEMES.has(theme) ? "light" : "dark" });
  await page.goto(`${server!.baseURL}/first-run-preview.html?theme=${theme}&${query}`);
  await expect(page.locator("[data-preview-shell]")).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready);
  // The welcome canvas fades in over 500ms and the checklist slides in on the
  // next frame; a mid-entry frame reads as a contrast defect that isn't there.
  await settle(page, 700);
}

async function currentStep(page: Page): Promise<string | null> {
  return page.locator(STEP).first().getAttribute("data-step");
}

async function waitForStep(page: Page, step: string): Promise<void> {
  const container = page.locator(`${STEP}[data-step="${step}"]`);
  await expect(container).toBeVisible({ timeout: 10_000 });
  // Visible is not painted: a step whose entry never runs sits at opacity 0 and
  // still passes every visibility check. Refuse the frame until it has arrived.
  await expect
    .poll(() => container.evaluate((el) => Number(getComputedStyle(el).opacity)), {
      timeout: 10_000,
    })
    .toBe(1);
  await settle(page, 450);
}

async function openWizardFromBanner(page: Page): Promise<void> {
  await page.locator('[data-testid="agent-setup-banner-cta"]').click();
  await expect(page.locator(WIZARD)).toBeVisible({ timeout: 10_000 });
}

async function clickContinue(page: Page): Promise<string | null> {
  const before = await currentStep(page);
  // The install step's forward move is "Set up later" until something installs.
  const button = page.locator(WIZARD).getByRole("button", { name: /^(continue|set up later)/i });
  await expect(button).toBeEnabled({ timeout: 10_000 });
  await button.click();
  await expect.poll(() => currentStep(page), { timeout: 10_000 }).not.toBe(before);
  await settle(page, 450);
  return currentStep(page);
}

async function checkFirstAgent(page: Page): Promise<void> {
  await page.locator(`${WIZARD} [role="checkbox"][aria-checked="false"]`).first().click();
  await settle(page, 200);
}

interface State {
  name: string;
  query: string;
  run?: (page: Page) => Promise<void>;
  /** Text the capture must show, or it is a picture of the wrong state. */
  expectText?: string;
  /** Text the capture must NOT show. */
  expectAbsent?: string;
}

const FRESH = "projects=0&onboarding=fresh";

const STATES: State[] = [
  // ── Welcome, before any setup ─────────────────────────────────────────
  { name: "10-fresh", query: `${FRESH}&agents=ready`, expectText: "Welcome to Daintree" },
  { name: "11-fresh-no-agents", query: `${FRESH}&agents=none`, expectText: "Welcome to Daintree" },
  {
    name: "12-banner-skipped-agents-found",
    query: `${FRESH}&agents=ready`,
    run: async (page) => {
      await page
        .getByRole("button", { name: /^not now$/i })
        .first()
        .click();
      await settle(page, 500);
    },
  },
  {
    name: "13-banner-skipped-no-agents",
    query: `${FRESH}&agents=none`,
    run: async (page) => {
      await page
        .getByRole("button", { name: /^not now$/i })
        .first()
        .click();
      await settle(page, 500);
    },
  },

  // ── The wizard, opened from the banner ───────────────────────────────
  {
    name: "20-wizard-appearance",
    query: `${FRESH}&agents=ready`,
    run: async (page) => {
      await openWizardFromBanner(page);
      await waitForStep(page, "appearance");
    },
  },
  {
    name: "21-wizard-agents",
    query: `${FRESH}&agents=ready`,
    run: async (page) => {
      await openWizardFromBanner(page);
      await waitForStep(page, "appearance");
      await clickContinue(page);
      await waitForStep(page, "agents");
      await settle(page, 400);
    },
  },
  {
    name: "22-wizard-privacy",
    query: `${FRESH}&agents=ready`,
    run: async (page) => {
      await openWizardFromBanner(page);
      await waitForStep(page, "appearance");
      await clickContinue(page);
      await clickContinue(page);
      await waitForStep(page, "privacy");
    },
  },
  {
    name: "23-wizard-permissions",
    query: `${FRESH}&agents=ready`,
    run: async (page) => {
      await openWizardFromBanner(page);
      await waitForStep(page, "appearance");
      for (let i = 0; i < 3; i++) await clickContinue(page);
      await waitForStep(page, "permissions");
    },
  },
  {
    name: "24-wizard-complete",
    query: `${FRESH}&agents=ready`,
    run: async (page) => {
      await openWizardFromBanner(page);
      await waitForStep(page, "appearance");
      for (let i = 0; i < 4; i++) await clickContinue(page);
      await waitForStep(page, "complete");
    },
  },
  {
    name: "25-after-wizard-finished",
    query: `${FRESH}&agents=ready`,
    run: async (page) => {
      await openWizardFromBanner(page);
      await waitForStep(page, "appearance");
      for (let i = 0; i < 4; i++) await clickContinue(page);
      await waitForStep(page, "complete");
      await page.locator(`${WIZARD} footer button, ${WIZARD} button`).last().click();
      await expect(page.locator(WIZARD)).toBeHidden({ timeout: 10_000 });
      await settle(page, 700);
    },
    expectAbsent: "Set up your AI agents",
  },
  {
    name: "26-after-wizard-not-now",
    query: `${FRESH}&agents=ready`,
    run: async (page) => {
      await openWizardFromBanner(page);
      await waitForStep(page, "appearance");
      await page.locator('[data-testid="agent-setup-exit"]').click();
      await expect(page.locator(WIZARD)).toBeHidden({ timeout: 10_000 });
      await settle(page, 700);
    },
    expectAbsent: "Set up your AI agents",
  },

  // ── Missing CLI ──────────────────────────────────────────────────────
  {
    name: "30-nocli-agents",
    query: `${FRESH}&agents=none`,
    run: async (page) => {
      await openWizardFromBanner(page);
      await waitForStep(page, "appearance");
      await clickContinue(page);
      await waitForStep(page, "agents");
      await settle(page, 400);
    },
  },
  {
    name: "31-nocli-install",
    query: `${FRESH}&agents=none`,
    run: async (page) => {
      await openWizardFromBanner(page);
      await waitForStep(page, "appearance");
      await clickContinue(page);
      await waitForStep(page, "agents");
      await checkFirstAgent(page);
      await clickContinue(page); // agents -> privacy
      await clickContinue(page); // privacy -> cli
      await waitForStep(page, "cli");
    },
  },
  {
    name: "32-nocli-complete",
    query: `${FRESH}&agents=none`,
    run: async (page) => {
      await openWizardFromBanner(page);
      await waitForStep(page, "appearance");
      await clickContinue(page);
      await waitForStep(page, "agents");
      await checkFirstAgent(page);
      for (let i = 0; i < 4; i++) await clickContinue(page);
      await waitForStep(page, "complete");
    },
  },
  {
    name: "33-git-missing",
    query: `${FRESH}&agents=ready&git=missing`,
    run: async (page) => {
      await openWizardFromBanner(page);
      await waitForStep(page, "appearance");
      await clickContinue(page);
      await waitForStep(page, "agents");
      await settle(page, 500);
    },
    expectText: "Git",
  },

  {
    name: "34-mixed-install",
    query: `${FRESH}&agents=ready`,
    run: async (page) => {
      await openWizardFromBanner(page);
      await waitForStep(page, "appearance");
      await clickContinue(page);
      await waitForStep(page, "agents");
      await checkFirstAgent(page); // Gemini, alongside the installed Claude and Codex
      await clickContinue(page); // agents -> privacy
      await clickContinue(page); // privacy -> cli
      await waitForStep(page, "cli");
    },
  },

  // ── After setup, before a project ────────────────────────────────────
  {
    name: "40-setup-done-no-project",
    query: "projects=0&onboarding=complete&agents=pinned",
  },

  // ── Returning user ───────────────────────────────────────────────────
  {
    name: "50-returning-in-progress",
    query: "projects=3&onboarding=complete&agents=pinned&checklist=opened",
    expectText: "Helios Dashboard",
  },
  {
    name: "51-returning-done",
    query: "projects=3&onboarding=complete&agents=pinned&checklist=dismissed",
    expectText: "Helios Dashboard",
  },
  {
    name: "52-returning-skipped-setup",
    // A returning user's opened projects were credited when they opened them.
    query: "projects=3&onboarding=skipped&agents=none&checklist=opened",
    expectText: "Helios Dashboard",
  },

  // ── First project open: start useful work ────────────────────────────
  {
    name: "60-project-first-open",
    query: "projects=1&onboarding=complete&agents=pinned",
    run: async (page) => {
      await page.evaluate(() =>
        (Reflect.get(window, "__firstRun") as { openProject: () => void }).openProject()
      );
      await settle(page, 900);
    },
  },
  {
    // Open project straight from a fresh welcome screen, banner untouched.
    name: "63-project-opened-without-setup",
    query: "projects=1&onboarding=fresh&agents=ready",
    run: async (page) => {
      await page.evaluate(() =>
        (Reflect.get(window, "__firstRun") as { openProject: () => void }).openProject()
      );
      await settle(page, 900);
    },
    expectText: "Getting started",
  },
  {
    name: "61-project-agent-launched",
    query: "projects=1&open=1&onboarding=complete&agents=pinned&checklist=launched",
  },
  {
    name: "62-project-skipped-setup",
    query: "projects=1&open=1&onboarding=skipped&agents=none",
  },
];

const selected = STATES.filter(
  (s) => ONLY.length === 0 || ONLY.some((prefix) => s.name.startsWith(prefix))
);

test("first-run journey preview — every state, every theme", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_FIRSTRUN is required for the first-run journey capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_FIRSTRUN=1 to run the capture");
  test.setTimeout(20 * 60_000);

  await settleDevServer(context);
  const snap = makeSnap(OUT_DIR);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const state of selected) {
      written.push(
        await withPage(context, `${state.name} ${theme}`, async (page) => {
          await open(page, theme, state.query);
          await state.run?.(page);
          const shell = page.locator("body");
          if (state.expectText) {
            await expect(shell, `${state.name} is not the state it names`).toContainText(
              state.expectText
            );
          }
          if (state.expectAbsent) {
            await expect(shell, `${state.name} still shows what it should not`).not.toContainText(
              state.expectAbsent
            );
          }
          // Park the pointer: a button the harness just clicked would
          // otherwise be photographed in its hover state.
          await page.mouse.move(1, 1);
          await settle(page, 200);
          return snap(page.locator("[data-preview-shell]"), `${state.name}-${theme}.png`);
        })
      );
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * selected.length);
  console.log(`[first-run-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
