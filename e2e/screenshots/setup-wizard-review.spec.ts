/**
 * AgentSetupWizard visual-review harness.
 *
 * Boots a fixture repo, opens the setup wizard through the same custom event
 * Settings / the toolbar / the welcome banner use, and walks every step of both
 * flows (first-run and re-run) writing a PNG per state so the wizard shell can
 * be judged against real rendered pixels.
 *
 * Opt-in only, like the other review harnesses: skips itself unless
 * DAINTREE_SHOT_WIZARD is set, so the marketing screenshots workflow never
 * executes it.
 *
 *   DAINTREE_SHOT_WIZARD=1 ./node_modules/.bin/playwright test \
 *     --project=screenshots setup-wizard-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_WIZARD  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME   optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG     optional suffix so rounds sit side by side
 *   DAINTREE_SHOT_ONLY    comma-separated step filter (see step names below)
 *   DAINTREE_SHOT_MEDIA   "reduced" | "forced-colors" | "contrast" — emulate
 *                         the matching media state for the whole run
 *   DAINTREE_SHOT_SCHEME  "dark" | "light" — emulate the OS colour scheme. The
 *                         first-run Appearance step replaces the default theme
 *                         with the OS's, so this, not DAINTREE_SHOT_THEME, is
 *                         what picks the theme a first-run sweep renders in
 *
 * Output: artifacts/wizard-shots/<NN-slug>[-tag].png (gitignored), or
 * DESIGN_CAPTURE_DIR when set. The privacy and settings-preview steps also write
 * a JSON note of what activating the telemetry preview did: where focus went,
 * whether the diagnostics dock opened, and whether the switch or step moved.
 *
 * Unlike a pass/fail spec this harness exists to produce artifacts, so it fails
 * loudly rather than quietly: a step that throws is recorded and re-raised at
 * the end, and the run asserts it actually wrote the files it claims.
 */

import { test, expect, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_WIZARD;
const DIALOG = '[data-testid="agent-setup-wizard"]';
/** The testid sits on the backdrop; the panel is its first child. */
const PANEL = `${DIALOG} > div`;
const STEP = '[data-testid="agent-setup-step"]';
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const MEDIA = process.env.DAINTREE_SHOT_MEDIA ?? "";
const SCHEME = process.env.DAINTREE_SHOT_SCHEME ?? "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : path.resolve(process.cwd(), "artifacts", "wizard-shots");

/**
 * Kills the caret and scrollbars so a re-run diffs cleanly. Animations are NOT
 * frozen here — `snap()` settles two frames plus a fixed wait instead, because
 * the step transition is one of the things under review and zeroing its
 * duration would hide a mid-flight layout jump rather than reveal it.
 */
const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after { caret-color: transparent !important; }
`;

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-wizard-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(path.join(dir, "src", "index.ts"), "export const main = (): number => 0;\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  git("branch develop", dir);
  git("checkout develop", dir);

  return {
    dir,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 450): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/** Every PNG this run claims to have written, verified against disk at the end. */
const written: string[] = [];

async function snap(page: Page, slug: string, locator?: string, wait = 450): Promise<void> {
  await settle(page, wait);
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  if (locator) {
    await page.locator(locator).first().screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", caret: "hide" });
  }
  written.push(file);
}

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const failures: string[] = [];

/**
 * Runs one capture group. A throw is recorded rather than aborting the sweep —
 * one broken state should not cost the other fifteen — but the recorded
 * failures are re-raised at the end so the run never reports success over a
 * missing artifact.
 */
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    failures.push(`${name}: ${String(error).slice(0, 400)}`);
  }
}

/** Opens the wizard through the same event Settings and the toolbar dispatch. */
async function openWizard(page: Page, isFirstRun: boolean): Promise<void> {
  await page.evaluate((firstRun) => {
    window.dispatchEvent(
      new CustomEvent("daintree:open-agent-setup-wizard", { detail: { isFirstRun: firstRun } })
    );
  }, isFirstRun);
  await page.locator(DIALOG).waitFor({ state: "visible", timeout: 15_000 });
  await page.locator(STEP).first().waitFor({ state: "visible", timeout: 15_000 });
}

async function closeWizard(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    if (
      !(await page
        .locator(DIALOG)
        .isVisible()
        .catch(() => false))
    )
      return;
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 250);
  }
}

/** The wizard's own state-machine step id, straight off the animated container. */
async function currentStep(page: Page): Promise<string> {
  return (await page.locator(STEP).first().getAttribute("data-step")) ?? "unknown";
}

async function clickContinue(page: Page): Promise<void> {
  await page
    .locator(DIALOG)
    .getByRole("button", { name: /^(continue|finish|next)/i })
    .first()
    .click();
  await settle(page, 500);
}

/**
 * Walks a flow from wherever it currently sits to `complete`, snapping each
 * step it lands on. Returns the ordered step ids it saw so the caller can
 * assert the flow actually branched the way it expected.
 */
async function walkFlow(page: Page, prefix: string, startIndex: number): Promise<string[]> {
  const seen: string[] = [];
  let index = startIndex;
  for (let guard = 0; guard < 8; guard++) {
    const stepId = await currentStep(page);
    seen.push(stepId);
    await snap(page, `${index}-${prefix}-${stepId}`, PANEL);
    await snap(page, `${index}-${prefix}-${stepId}-window`);
    if (stepId === "complete") break;
    index += 1;
    await clickContinue(page);
  }
  return seen;
}

test("agent setup wizard review — every step of both flows", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_WIZARD is required for the wizard capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_WIZARD to run the wizard capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-wizardshot-"));
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    if (THEME) await setAppTheme(page, THEME);
    if (SCHEME === "dark" || SCHEME === "light") await page.emulateMedia({ colorScheme: SCHEME });
    if (MEDIA === "reduced") await page.emulateMedia({ reducedMotion: "reduce" });
    if (MEDIA === "forced-colors") await page.emulateMedia({ forcedColors: "active" });
    if (MEDIA === "contrast") await page.emulateMedia({ contrast: "more" }).catch(() => {});
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await page
      .locator(SEL.worktree.mainCard)
      .waitFor({ state: "visible", timeout: T_LONG })
      .catch(() => {});
    await settle(page, 2000);
    await dismissBlockingPalette(page);

    // 1. Loading — the availability skeleton, caught before the first probe
    // resolves. Snapped with no settle wait so it is not raced away.
    await step("loading", async () => {
      await openWizard(page, false);
      await snap(page, "05-rerun-agents-loading", PANEL, 0);
      await closeWizard(page);
    });

    // 2. First run — the full flow, the shot the redesign is judged on.
    await step("first-run", async () => {
      await openWizard(page, true);
      const seen = await walkFlow(page, "first", 10);
      expect(seen[0]).toBe("appearance");
      expect(seen).toContain("input");
      expect(seen.at(-1)).toBe("complete");
      await closeWizard(page);
    });

    // 3. Re-run from Settings — the shorter flow, and the one whose progress
    // model has to survive the conditional cli step disappearing.
    await step("rerun", async () => {
      await openWizard(page, false);
      const seen = await walkFlow(page, "rerun", 30);
      expect(seen[0]).toBe("agents");
      expect(seen).not.toContain("input");
      expect(seen.at(-1)).toBe("complete");
      await closeWizard(page);
    });

    // 4. Nothing selected — the disabled-Continue state plus its footer hint.
    // AgentCard renders the house Radix checkbox: a button with role=checkbox.
    await step("no-selection", async () => {
      await openWizard(page, false);
      const boxes = page.locator(`${DIALOG} [role="checkbox"][aria-checked="true"]`);
      for (let guard = 0; guard < 20 && (await boxes.count()) > 0; guard++) {
        await boxes.first().click();
        await settle(page, 120);
      }
      expect(await boxes.count(), "agents remained selected").toBe(0);
      await snap(page, "50-agents-none-selected", PANEL);
      await closeWizard(page);
    });

    // 5. The conditional cli step — only reachable with an agent selected that
    // is NOT already installed, which is why the default sweep never sees it.
    await step("cli", async () => {
      await openWizard(page, true);
      await clickContinue(page); // appearance -> agents
      const unchecked = page.locator(`${DIALOG} [role="checkbox"][aria-checked="false"]`);
      if ((await unchecked.count()) > 0) {
        await unchecked.first().click();
        await settle(page, 250);
      }
      for (let guard = 0; guard < 4 && (await currentStep(page)) !== "cli"; guard++) {
        await clickContinue(page);
      }
      expect(await currentStep(page), "never reached the cli step").toBe("cli");
      await snap(page, "20-first-cli", PANEL);
      await snap(page, "20-first-cli-window");
      await clickContinue(page); // cli -> permissions, with cli genuinely visited
      await snap(page, "21-first-permissions-after-cli", PANEL);
      await closeWizard(page);
    });

    // 6. Focus after an advance. jsdom flattens AnimatePresence, so the unit
    // test cannot reproduce the `mode="wait"` timing that put focus on the
    // OUTGOING heading — this is the check that does.
    await step("focus-after-advance", async () => {
      await openWizard(page, true);
      await clickContinue(page); // appearance -> agents
      await settle(page, 700);
      const focused = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return {
          tag: el?.tagName ?? "none",
          text: (el?.textContent ?? "").trim().slice(0, 60),
          inDialog: !!el?.closest('[data-testid="agent-setup-wizard"]'),
        };
      });
      expect(focused.inDialog, `focus escaped the dialog: ${JSON.stringify(focused)}`).toBe(true);
      expect(focused.tag, `focus should land on the step heading: ${JSON.stringify(focused)}`).toBe(
        "H3"
      );
      expect(focused.text).toBe("Choose your AI agents");
      await snap(page, "62-focus-after-advance", PANEL);
      await closeWizard(page);
    });

    // 7. Keyboard focus — where the ring lands on entry, and on the footer.
    await step("keyboard", async () => {
      await openWizard(page, true);
      await page.keyboard.press("Tab");
      await snap(page, "60-appearance-focus-first", PANEL);
      for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
      await snap(page, "61-appearance-focus-footer", PANEL);
      await closeWizard(page);
    });

    // 8. Privacy — the consent step at rest, then its "what would be sent"
    // control activated from the keyboard. Whatever it shows has to be usable
    // without leaving the wizard, so the note records where focus went, whether
    // the diagnostics dock opened behind the scrim, and whether the switch or
    // the step moved, next to the pixels.
    await step("privacy", async () => {
      await openWizard(page, true);
      await clickContinue(page); // appearance -> agents
      await clickContinue(page); // agents -> privacy
      expect(await currentStep(page), "never reached the privacy step").toBe("privacy");
      await snap(page, "70-privacy-rest", PANEL);

      const control = page
        .locator(`${STEP} button`)
        .filter({ hasText: /preview|crash report/i })
        .first();
      await control.waitFor({ state: "visible", timeout: 5_000 });
      // Reach it the way a keyboard user does, so the ring is the real one.
      const handle = await control.elementHandle();
      for (let guard = 0; guard < 8; guard++) {
        const onControl = await page.evaluate((el) => document.activeElement === el, handle);
        if (onControl) break;
        await page.keyboard.press("Tab");
      }
      await page.keyboard.press("Enter");
      await settle(page, 700);
      await snap(page, "71-privacy-preview", PANEL);
      await snap(page, "72-privacy-preview-window");

      const observed = await page.evaluate(async (dialog) => {
        const el = document.activeElement as HTMLElement | null;
        const dock = document.querySelector<HTMLElement>('[aria-label="Diagnostics dock"]');
        const sw = document.querySelector(`${dialog} [role="switch"]`);
        const preview = await window.electron.telemetry.preview.getState().catch(() => null);
        return {
          step: document.querySelector("[data-step]")?.getAttribute("data-step") ?? null,
          focus: {
            tag: el?.tagName ?? "none",
            text: (el?.textContent ?? "").trim().slice(0, 80),
            inDialog: !!el?.closest(dialog),
          },
          switchChecked: sw?.getAttribute("aria-checked") ?? null,
          dockVisible: !!dock && dock.getBoundingClientRect().height > 0,
          previewActive: preview?.active ?? null,
        };
      }, DIALOG);
      writeFileSync(
        path.join(OUTPUT_DIR, `privacy-preview-state${TAG}.json`),
        JSON.stringify(observed, null, 2)
      );

      await page.locator(`${DIALOG} [role="switch"]`).first().click();
      await snap(page, "73-privacy-preview-toggle-on", PANEL);
      await closeWizard(page);
    });

    // 9. Settings → Privacy & data → "Open preview" — the same action from
    // inside the Settings dialog. The dock it opens has to be the thing in front
    // of the user afterwards, not something dimmed behind the Settings scrim.
    await step("settings-preview", async () => {
      await page.evaluate(() => window.electron.telemetry.preview.toggle(false)).catch(() => {});
      const closeDock = page.locator('[aria-label="Close diagnostics dock"]');
      if (await closeDock.isVisible().catch(() => false)) await closeDock.click();
      await settle(page, 300);

      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("daintree:open-settings-tab", {
            detail: { tab: "privacy", subtab: "telemetry" },
          })
        );
      });
      const openPreview = page.getByRole("button", { name: "Open preview" });
      await openPreview.waitFor({ state: "visible", timeout: 15_000 });
      await openPreview.scrollIntoViewIfNeeded();
      await snap(page, "80-settings-privacy");
      // The same crash-report contents the wizard discloses, as Settings lists them.
      const collected = page.getByText("What's collected at each level");
      await collected.scrollIntoViewIfNeeded();
      await page.evaluate(() =>
        document
          .evaluate(
            '//*[text()="What\'s collected at each level"]',
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          )
          .singleNodeValue?.parentElement?.scrollIntoView({ block: "start" })
      );
      await snap(page, "82-settings-whats-collected");
      await openPreview.scrollIntoViewIfNeeded();
      // From the keyboard, so the capture shows where a keyboard user lands.
      await openPreview.focus();
      await page.keyboard.press("Enter");
      await settle(page, 1200);
      await snap(page, "81-settings-open-preview-window");

      const observed = await page.evaluate(async (settingsClose) => {
        const el = document.activeElement as HTMLElement | null;
        const dock = document.querySelector<HTMLElement>('[aria-label="Diagnostics dock"]');
        const preview = await window.electron.telemetry.preview.getState().catch(() => null);
        return {
          settingsOpen: !!document.querySelector(settingsClose),
          dockVisible: !!dock && dock.getBoundingClientRect().height > 0,
          focusInDock: !!el && !!dock?.contains(el),
          focus: {
            tag: el?.tagName ?? "none",
            role: el?.getAttribute("role") ?? null,
            text: (el?.textContent ?? "").trim().slice(0, 80),
          },
          previewActive: preview?.active ?? null,
        };
      }, SEL.settings.closeButton);
      writeFileSync(
        path.join(OUTPUT_DIR, `settings-preview-state${TAG}.json`),
        JSON.stringify(observed, null, 2)
      );

      const closeSettings = page.locator(SEL.settings.closeButton);
      if (await closeSettings.isVisible().catch(() => false)) await closeSettings.click();
      if (await closeDock.isVisible().catch(() => false)) await closeDock.click();
      await page.evaluate(() => window.electron.telemetry.preview.toggle(false)).catch(() => {});
    });
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  // A harness that reports success without artifacts is worse than one that
  // fails: verify every claimed PNG landed, then surface any step that threw.
  const missing = written.filter((f) => !existsSync(f));
  expect(missing, `claimed screenshots missing from disk: ${missing.join(", ")}`).toEqual([]);
  const onDisk = readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(`${TAG}.png`));
  expect(onDisk.length, "no screenshots were written").toBeGreaterThan(0);
  expect(failures, `capture steps failed:\n${failures.join("\n")}`).toEqual([]);
});
