/**
 * `NonGitFolderDialog` visual-review harness.
 *
 * The choice screen a user lands on when the folder they opened is not a git
 * repository: adopt it as-is, or set git up first. It is small, so what is wrong
 * with it is mostly what a PNG shows and the JSX hides — which control holds
 * focus on arrival, whether the two answers read as a pair or as a primary and
 * an afterthought, and how the path and the explanation compete for the eye.
 *
 * Every state is reached through the real seam: the native picker is mocked to
 * return a plain folder, `addProjectByPath` fails `NOT_A_GIT_REPO`, and the
 * store re-emerges it as this dialog. No renderer mocks.
 *
 *   DAINTREE_SHOT_NONGIT=1 npx playwright test --project=screenshots non-git-folder-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_NONGIT  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEMES  comma-separated theme sweep (default: every built-in)
 *   DAINTREE_SHOT_ONLY    comma-separated step filter (see step names below)
 *   DAINTREE_SHOT_OUT     absolute output dir (default artifacts/non-git-folder-shots)
 *
 * Output: <out>/<NN-slug>.png plus <out>/focus.json, which records the element
 * holding focus on arrival — the one fact about this surface a still image can
 * only show when the ring happens to paint.
 */

import { test, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, mockOpenDialog, type AppContext } from "../helpers/launch";
import { dismissTelemetryConsent } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_NONGIT;
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR =
  process.env.DAINTREE_SHOT_OUT ?? path.resolve(process.cwd(), "artifacts", "non-git-folder-shots");
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

const ALL_THEMES = [
  "arashiyama",
  "atacama",
  "bali",
  "bondi",
  "daintree",
  "fiordland",
  "galapagos",
  "highlands",
  "hokkaido",
  "movile",
  "namib",
  "redwoods",
  "serengeti",
  "svalbard",
  "table-mountain",
];
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "").split(",").filter(Boolean);
const SWEEP = THEMES.length > 0 ? THEMES : ALL_THEMES;

/**
 * The dialog CARD. `AppDialog` puts `role="dialog"` on the full-window scrim, so
 * a role selector screenshots the whole window and looks like a good crop.
 */
const DIALOG = "[data-app-dialog-surface] > div";

/** Present only while the choice screen (not git setup) is the dialog on screen. */
const CHOICE_MARKER = '[data-testid="non-git-folder-dialog"]';

const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

function makePlainFolder(root: string, rel: string): string {
  const dir = path.join(root, rel);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# notes\n");
  writeFileSync(path.join(dir, "src", "index.ts"), "export const start = () => {};\n");
  return dir;
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/** Screenshot only once the claimed state is proven on screen, before and after the settle. */
async function snap(
  page: Page,
  slug: string,
  opts: { marker?: string; full?: boolean; settleMs?: number } = {}
): Promise<void> {
  const marker = opts.marker ?? CHOICE_MARKER;
  await page.locator(marker).first().waitFor({ state: "visible", timeout: 8000 });
  await settle(page, opts.settleMs);
  if (!(await page.locator(marker).first().isVisible())) {
    throw new Error(`[non-git-shots] "${slug}": marker ${marker} vanished before the shot`);
  }
  const file = path.join(OUTPUT_DIR, `${slug}.png`);
  if (opts.full) {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  } else {
    await page.locator(DIALOG).last().screenshot({ path: file, type: "png" });
  }
}

async function setWelcomeTheme(page: Page, schemeId: string): Promise<void> {
  await page.evaluate(async (id) => {
    await window.electron.appTheme.setColorScheme(id);
  }, schemeId);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(SEL.welcome.openFolder).waitFor({ state: "visible", timeout: T_LONG });
  const applied = await page.locator("html").evaluate((el) => el.getAttribute("data-theme"));
  if (applied !== schemeId) {
    throw new Error(`[non-git-shots] theme ${schemeId} did not apply (got ${applied})`);
  }
  await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
}

const failures: string[] = [];

test("non-git folder dialog review — choice screen across entry paths and themes", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_NONGIT is required for the non-git folder capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_NONGIT to run the non-git folder capture");
  test.setTimeout(15 * 60_000);

  failures.length = 0;
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "daintree-nongit-shots-"));
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-nongitshot-"));
  // Cancelling the choice adds nothing, so one folder serves every visit.
  const plain = makePlainFolder(fixtureRoot, "aurora-notes");
  const deep = makePlainFolder(
    fixtureRoot,
    path.join(
      "clients",
      "northwind-logistics",
      "archive-2024",
      "handover",
      "meridian-observability-platform-ingestion-and-rollup-services"
    )
  );
  const parentForCreateFlow = path.join(fixtureRoot, "workspace");
  mkdirSync(parentForCreateFlow, { recursive: true });

  let ctx: AppContext | undefined;
  const focusReport: Record<string, unknown> = {};

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const app = ctx.app;
    const page = ctx.window;

    await dismissTelemetryConsent(page);
    await dismissBlockingPalette(page);
    await page.locator(SEL.welcome.openFolder).waitFor({ state: "visible", timeout: T_LONG });
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await settle(page, 600);

    const openChoice = async (dir: string): Promise<void> => {
      await mockOpenDialog(app, dir);
      await page.locator(SEL.welcome.openFolder).click();
      await page.locator(CHOICE_MARKER).waitFor({ state: "visible", timeout: 15000 });
    };

    const describeActive = () =>
      page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return null;
        return {
          tag: el.tagName.toLowerCase(),
          text: (el.textContent ?? "").trim().slice(0, 60),
          ariaLabel: el.getAttribute("aria-label"),
          focusVisible: el.matches(":focus-visible"),
        };
      });

    const closeDialog = async (): Promise<void> => {
      for (let i = 0; i < 10; i++) {
        if (
          !(await page
            .locator(DIALOG)
            .first()
            .isVisible()
            .catch(() => false))
        )
          return;
        await page.keyboard.press("Escape").catch(() => {});
        await settle(page, 250);
      }
      throw new Error("[non-git-shots] dialog would not close");
    };

    const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
      if (ONLY.length > 0 && !ONLY.includes(name)) return;
      try {
        await fn();
      } catch (error) {
        const detail = String(error).slice(0, 600);
        console.warn(`[non-git-shots] step "${name}" failed:`, detail);
        failures.push(`${name}: ${detail}`);
      } finally {
        await closeDialog().catch((error) => {
          failures.push(`${name} (reset): ${String(error).slice(0, 200)}`);
        });
        await page.emulateMedia({ forcedColors: null, contrast: null }).catch(() => {});
      }
    };

    // 1. The headline state, reached the way almost everyone reaches it.
    await step("direct", async () => {
      await openChoice(plain);
      await settle(page, 300);
      focusReport.onArrival = await describeActive();
      await snap(page, "10-choice");
      await snap(page, "11-choice-in-window", { full: true });
    });

    // 2. Keyboard: where Tab goes from the arrival focus, one and two presses in.
    await step("keyboard", async () => {
      await openChoice(plain);
      await settle(page, 300);
      await page.keyboard.press("Tab");
      focusReport.afterTab1 = await describeActive();
      await snap(page, "20-focus-tab-1");
      await page.keyboard.press("Tab");
      focusReport.afterTab2 = await describeActive();
      await snap(page, "21-focus-tab-2");
    });

    // 3. A leaf long enough to test the title and the path caption together.
    await step("long-path", async () => {
      await openChoice(deep);
      await snap(page, "30-long-path");
    });

    // 4. Arrival from the create-project-folder flow — the other real entry point.
    await step("create-flow", async () => {
      await page.getByRole("button", { name: "Create project", exact: true }).click();
      const inDialog = (name: string) =>
        page.locator("[data-app-dialog-surface]").getByRole("button", { name, exact: true });
      await inDialog("Browse for a location").waitFor({ state: "visible", timeout: 8000 });
      await mockOpenDialog(app, parentForCreateFlow);
      await inDialog("Browse for a location").click();
      await page.locator("#create-folder-name").fill("telemetry-pipeline");
      await inDialog("Create folder").click();
      await page.locator(CHOICE_MARKER).waitFor({ state: "visible", timeout: 15000 });
      await snap(page, "35-from-create-flow");
    });

    // 5. prefers-contrast: more — macOS "Increase contrast".
    await step("contrast", async () => {
      await page.emulateMedia({ contrast: "more" });
      await openChoice(plain);
      await snap(page, "70-contrast-more");
    });

    // 6. forced-colors: active — anything carried by tint alone collapses here.
    await step("forced", async () => {
      await page.emulateMedia({ forcedColors: "active" });
      await openChoice(plain);
      await snap(page, "75-forced-colors");
    });

    // 7. Every theme, last, since each one reloads the renderer.
    if (ONLY.length === 0 || ONLY.includes("themes")) {
      for (const theme of SWEEP) {
        await step(`theme:${theme}`, async () => {
          await setWelcomeTheme(page, theme);
          await openChoice(plain);
          await snap(page, `80-theme-${theme}`);
        });
      }
    }
  } finally {
    writeFileSync(path.join(OUTPUT_DIR, "focus.json"), JSON.stringify(focusReport, null, 2));
    if (ctx?.app) await closeApp(ctx.app).catch(() => {});
    for (const dir of [fixtureRoot, userDataDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }

  // Counted, not trusted from the exit code: swallowed per-step errors are how a
  // harness reports PASS over an empty directory.
  const written = existsSync(OUTPUT_DIR)
    ? readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")).length
    : 0;
  console.log(`[non-git-shots] wrote ${written} png(s) to ${OUTPUT_DIR}`);

  if (failures.length > 0) {
    throw new Error(`[non-git-shots] ${failures.length} step(s) failed:\n${failures.join("\n")}`);
  }
  if (written === 0) {
    throw new Error(`[non-git-shots] no PNGs written to ${OUTPUT_DIR}`);
  }
});
