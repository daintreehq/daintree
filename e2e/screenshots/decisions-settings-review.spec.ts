/**
 * Settings → Integrations → Decisions visual-review harness (#16004).
 *
 * Boots a real project and walks the page the way a person meets it: off, the
 * consent dialog the first switch-on opens, on through the real IPC, and
 * search. States main can't reach yet (a relay connecting, connected or
 * refused, a failed switch, a status that can't be read, what a relay check
 * saw) are its own answers to `decisions:get-status`, `decisions:set-enabled`
 * and `decisions:check-relay` (#16005), put in place in main
 * before the settings dialog is opened again, so the renderer under review
 * reads them through the same seam it always does.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_DECISIONS=1 DESIGN_CAPTURE_DIR=/tmp/decisions-shots \
 *     DAINTREE_SHOT_THEME=daintree,bondi \
 *     npx playwright test --project=screenshots decisions-settings-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_DECISIONS    required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR         required — output directory (never the repo)
 *   DAINTREE_SHOT_THEME        comma-separated theme ids (default: daintree)
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 2)
 *
 * Output: <dir>/<NN-state>[--p<slice>]--<theme>.png. Every state asserts what
 * it drove is on screen before it writes, and the run fails at the end with
 * the states it couldn't capture.
 */

import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import type { DecisionsRelayCheck, DecisionsStatus } from "../../shared/types/decisions";

const ENABLED = !!process.env.DAINTREE_SHOT_DECISIONS;
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : "";
const THEMES = (process.env.DAINTREE_SHOT_THEME ?? "daintree")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";

const DIALOG = '[role="dialog"]:has(.settings-sidebar)';
const CARD = '[role="dialog"]:has(.settings-sidebar) > div';
const PANEL = "#settings-panel-decisions";
const CLOSE = '[aria-label="Close settings"]';
const SWITCH = '[role="switch"][aria-labelledby]';
const RELAY = "https://decisions.greg-priday.workers.dev";
const CONSENTED = 1_761_955_200_000;

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

const failures: string[] = [];
const written: string[] = [];

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createRepo(root: string): string {
  const dir = path.join(root, "acme-api");
  mkdirSync(dir, { recursive: true });
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), "# acme-api\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  return dir;
}

async function settle(page: Page, ms = 300): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function openDecisions(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("daintree:open-settings-tab", { detail: { tab: "decisions" } })
    );
  });
  await page.locator(DIALOG).waitFor({ state: "visible", timeout: 20_000 });
  await page.locator(PANEL).waitFor({ state: "visible", timeout: 15_000 });
  await settle(page, 400);
}

async function closeSettings(page: Page): Promise<void> {
  await page.locator(CLOSE).click();
  await page.locator(DIALOG).waitFor({ state: "detached", timeout: 10_000 });
  await settle(page, 200);
}

/** Main answers these the way the real ops would, until the run ends. */
async function answerStatus(app: ElectronApplication, status: DecisionsStatus): Promise<void> {
  await app.evaluate(({ ipcMain }, next) => {
    ipcMain.removeHandler("decisions:get-status");
    ipcMain.handle("decisions:get-status", async () => next);
  }, status);
}

/** What every relay check sees, so no capture reaches the network. */
async function answerRelayCheck(app: ElectronApplication, check: DecisionsRelayCheck): Promise<void> {
  await app.evaluate(({ ipcMain }, next) => {
    ipcMain.removeHandler("decisions:check-relay");
    ipcMain.handle("decisions:check-relay", async () => next);
  }, check);
}

async function failStatus(app: ElectronApplication, message: string): Promise<void> {
  await app.evaluate(({ ipcMain }, text) => {
    ipcMain.removeHandler("decisions:get-status");
    ipcMain.handle("decisions:get-status", async () => {
      throw new Error(text);
    });
  }, message);
}

async function failSwitch(app: ElectronApplication, message: string): Promise<void> {
  await app.evaluate(({ ipcMain }, text) => {
    ipcMain.removeHandler("decisions:set-enabled");
    ipcMain.handle("decisions:set-enabled", async () => {
      throw new Error(text);
    });
  }, message);
}

function fileFor(state: string, theme: string, slice?: number): string {
  return path.join(OUTPUT_DIR, `${state}${slice ? `--p${slice}` : ""}--${theme}.png`);
}

function verifyWritten(file: string): void {
  if (!existsSync(file) || statSync(file).size < 4000) {
    throw new Error(`${path.basename(file)}: capture missing or implausibly small`);
  }
  written.push(file);
}

/** The settings card, top to bottom, in slices down the panel's real scrollport. */
async function capturePage(page: Page, state: string, theme: string, expectText: string) {
  await expect(page.locator(PANEL).getByText(expectText, { exact: false }).first()).toBeVisible({
    timeout: 8000,
  });
  const { scrollHeight, clientHeight } = await page.evaluate((selector) => {
    const panel = document.querySelector(selector);
    let el = panel?.parentElement ?? null;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.clientHeight > 0) break;
      el = el.parentElement;
    }
    if (!el) throw new Error("no scroll container above the Decisions panel");
    document.querySelectorAll("[data-shot-scroller]").forEach((n) => {
      n.removeAttribute("data-shot-scroller");
    });
    el.setAttribute("data-shot-scroller", "");
    el.scrollTop = 0;
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  }, PANEL);
  const step = Math.max(200, Math.floor(clientHeight * 0.85));
  const slices = Math.min(4, Math.max(1, Math.ceil((scrollHeight - clientHeight) / step) + 1));
  for (let i = 0; i < slices; i++) {
    await page.evaluate((top) => {
      const el = document.querySelector<HTMLElement>("[data-shot-scroller]");
      if (el) el.scrollTop = top;
    }, i * step);
    await settle(page, 200);
    // Re-checked after the settle, so a late answer can't swap the state under the shot.
    await expect(
      page.locator(PANEL).getByText(expectText, { exact: false }).first()
    ).toBeAttached();
    const file = fileFor(state, theme, slices > 1 ? i + 1 : undefined);
    await page.locator(CARD).first().screenshot({
      path: file,
      type: "png",
      animations: "disabled",
      caret: "hide",
    });
    verifyWritten(file);
  }
}

async function captureWindow(page: Page, state: string, theme: string, expectSelector: string) {
  await settle(page, 300);
  await expect(page.locator(expectSelector).first()).toBeVisible({ timeout: 8000 });
  const file = fileFor(state, theme);
  await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  verifyWritten(file);
}

/** Runs one state; a failure is recorded with what the page said instead, and nothing is written. */
async function step(page: Page, name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const said = await page
      .locator(`${DIALOG}, [role="dialog"]`)
      .last()
      .innerText({ timeout: 2000 })
      .catch(() => "(no dialog)");
    failures.push(
      `${name}: ${String(error).split("\n")[0]} — on screen: ${said.replace(/\s+/g, " ").slice(-600)}`
    );
    await page.keyboard.press("Escape").catch(() => {});
  }
}

test("Decisions settings page review — every state, per theme", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_DECISIONS is required for the Decisions settings capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_DECISIONS=1 to run this capture");
  if (!OUTPUT_DIR)
    throw new Error("DESIGN_CAPTURE_DIR must be set to a directory outside the repo");
  test.setTimeout(12 * 60_000);
  mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const theme of THEMES) {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "daintree-decisionsshot-repos-"));
    const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-decisionsshot-"));
    const dir = createRepo(repoRoot);
    let ctx: AppContext | undefined;
    try {
      ctx = await launchApp({
        userDataDir,
        screenshotScale: SCALE,
        windowSize: { width: 1440, height: 960 },
        extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
      });
      const app = ctx.app;
      const page = await openAndOnboardProject(app, ctx.window, dir, "Acme API");
      await setAppTheme(page, theme);
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await dismissBlockingPalette(page);
      await settle(page, 800);

      // 01 — first visit: off, nothing behind the switch.
      await step(page, "01-off", async () => {
        await openDecisions(page);
        await expect(page.locator(`${PANEL} ${SWITCH}`)).toHaveAttribute("aria-checked", "false");
        await capturePage(page, "01-off", theme, "Enable Decisions");
      });

      // 02 — the first switch-on asks first; the switch stays off behind it.
      await step(page, "02-consent", async () => {
        await page.locator(`${PANEL} ${SWITCH}`).click();
        await expect(page.getByRole("button", { name: "Turn on Decisions" })).toBeVisible({
          timeout: 8000,
        });
        await expect(page.locator(`${PANEL} ${SWITCH}`)).toHaveAttribute("aria-checked", "false");
        await captureWindow(page, "02-consent", theme, 'button:has-text("Turn on Decisions")');
      });

      // 03 — agreed: on through the real IPC, not connected, every section shown.
      await step(page, "03-on", async () => {
        await page.getByRole("button", { name: "Turn on Decisions" }).click();
        await expect(page.locator(`${PANEL} ${SWITCH}`)).toHaveAttribute("aria-checked", "true", {
          timeout: 10_000,
        });
        await capturePage(page, "03-on", theme, "Not connected");
      });

      // 04 — search finds the page and its sections.
      await step(page, "04-search", async () => {
        await closeSettings(page);
        await openDecisions(page);
        await page
          .getByRole("searchbox", { name: "Search settings" })
          .or(page.locator('input[aria-label="Search settings"]'))
          .first()
          .fill("phone");
        await captureWindow(page, "04-search", theme, '[aria-label="Search results"]');
        await closeSettings(page);
      });

      // 05-07 — what main reports as the relay connection moves. Connected
      // checks the saved relay by itself; this one is a release behind.
      await answerRelayCheck(app, {
        result: "claimed",
        origin: RELAY,
        compatibility: {
          relay: { protocolMin: 1, protocolMax: 1, workerVersion: "0.0.9" },
          daintree: { protocolMin: 1, protocolMax: 1, workerVersion: "0.1.0" },
          diverges: true,
        },
      });
      const relayStates: [string, DecisionsStatus, string][] = [
        [
          "05-connecting",
          { state: "connecting", relayOrigin: RELAY, consentedAt: CONSENTED },
          "Connecting to",
        ],
        [
          "06-connected",
          { state: "connected", relayOrigin: RELAY, consentedAt: CONSENTED },
          "Connected to",
        ],
        [
          "07-revoked",
          { state: "revoked", relayOrigin: RELAY, consentedAt: CONSENTED },
          "Refused by",
        ],
      ];
      for (const [state, status, words] of relayStates) {
        await step(page, state, async () => {
          await answerStatus(app, status);
          await openDecisions(page);
          await capturePage(page, state, theme, words);
          await closeSettings(page);
        });
      }

      // 08 — turning on fails; the switch stays off and the failure sits under it.
      await step(page, "08-switch-failed", async () => {
        await answerStatus(app, { state: "off", consentedAt: CONSENTED });
        await failSwitch(app, "The settings file couldn't be written. Check the disk has space.");
        await openDecisions(page);
        await page.locator(`${PANEL} ${SWITCH}`).click();
        await capturePage(page, "08-switch-failed", theme, "Couldn't turn on Decisions");
        await closeSettings(page);
      });

      // 09 — the status can't be read at all.
      await step(page, "09-load-error", async () => {
        await failStatus(
          app,
          "Settings couldn't be read from disk. Check that the disk isn't full."
        );
        await openDecisions(page);
        await capturePage(page, "09-load-error", theme, "Couldn't read whether Decisions is on");
        await closeSettings(page);
      });

      // 10-12 — a typed relay URL, checked: ready to claim, a protocol
      // Daintree doesn't speak, and no answer at all.
      const checks: [string, DecisionsRelayCheck, string][] = [
        [
          "10-check-unclaimed",
          {
            result: "unclaimed",
            origin: RELAY,
            compatibility: {
              relay: { protocolMin: 1, protocolMax: 1, workerVersion: "0.1.0" },
              daintree: { protocolMin: 1, protocolMax: 1, workerVersion: "0.1.0" },
              diverges: false,
            },
          },
          "is ready to claim",
        ],
        [
          "11-check-incompatible",
          {
            result: "incompatible",
            origin: RELAY,
            compatibility: {
              relay: { protocolMin: 2, protocolMax: 3, workerVersion: "0.4.0" },
              daintree: { protocolMin: 1, protocolMax: 1, workerVersion: "0.1.0" },
              diverges: true,
            },
          },
          "speaks a protocol Daintree doesn't",
        ],
        [
          "12-check-unreachable",
          { result: "unreachable", origin: RELAY, endpoint: "health", reason: "dns" },
          "Couldn't reach",
        ],
      ];
      for (const [state, check, words] of checks) {
        await step(page, state, async () => {
          await answerStatus(app, { state: "not-connected", consentedAt: CONSENTED });
          await answerRelayCheck(app, check);
          await openDecisions(page);
          await page.getByPlaceholder("https://decisions.example.workers.dev").fill(RELAY);
          await page.getByRole("button", { name: "Check", exact: true }).click();
          await capturePage(page, state, theme, words);
          await closeSettings(page);
        });
      }
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      for (const target of [repoRoot, userDataDir]) {
        if (!existsSync(target)) continue;
        try {
          rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch (error) {
          console.warn(
            `[decisions-shots] could not remove ${target}:`,
            String(error).split("\n")[0]
          );
        }
      }
    }
  }

  console.log(`[decisions-shots] wrote ${written.length} files to ${OUTPUT_DIR}`);
  expect(failures, failures.join("\n")).toEqual([]);
});
