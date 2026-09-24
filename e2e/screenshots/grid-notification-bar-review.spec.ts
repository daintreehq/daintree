/**
 * GridNotificationBar visual-review harness.
 *
 * The grid bar is the single-slot strip at the top of the panel grid that
 * carries signals from outside the visible UI: "Agent waiting for input",
 * "GitHub integration is off", "High system memory use", "Terminal output
 * stalled". Each state below injects the real copy and action manifest those
 * emitters send, through the E2E notification backdoor
 * (`src/lib/e2eNotificationBackdoor.ts`), which writes the store the bar
 * subscribes to. A short placeholder message hides exactly the wrapping and
 * truncation defects worth finding, so the fixtures are deliberately the long
 * real ones.
 *
 * Each shot is the bar plus a band of the grid beneath it, so the bar is judged
 * against the panes it sits over, not in isolation. Every state is verified
 * painted before its PNG is written: a capture of an empty bar throws.
 *
 * Steps (each also the DAINTREE_SHOT_ONLY filter name):
 *
 *   severities  info/warning/error/success with the real emitters' copy
 *   actions     two actions (primary + secondary), one action, none
 *   narrow      the two-action nudge in a narrow window, where it has to wrap
 *   focus       keyboard focus on the primary action and on the dismiss
 *   hover       pointer over the secondary action and over the dismiss
 *   window      the whole window with the bar up, for context
 *   contrast    `prefers-contrast: more`
 *   forced      `forced-colors: active`
 *   themes      the two-action nudge and the warning across four palettes
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_GRIDBAR is set.
 *
 *   DAINTREE_SHOT_GRIDBAR=1 npx playwright test --project=screenshots grid-notification-bar-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_GRIDBAR  required — any truthy value runs the capture
 *   DAINTREE_SHOT_ONLY     comma-separated step filter (see step names above)
 *   DESIGN_CAPTURE_DIR     optional output dir, so review rounds write outside the tree
 *
 * Output: artifacts/grid-notification-bar-shots/<NN-slug>.png (gitignored).
 */

import { test, type CDPSession, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { openTerminal } from "../helpers/panels";
import {
  injectGridNotification,
  resetNotifications,
  type InjectToastOptions,
} from "../helpers/notifications";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_GRIDBAR;
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : path.resolve(process.cwd(), "artifacts", "grid-notification-bar-shots");

const BAR = SEL.notifications.gridBar;
const STATUS = SEL.notifications.gridBarStatus;

const POLISH_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

type Fixture = InjectToastOptions & { expect: string };

// Copy and manifests are the emitters' own: useAgentWaitingNudge,
// useForgeEnableRecommendation, useSystemMemoryPressureNotice,
// useForceResumeCycleWatchdog.
const WAITING: Fixture = {
  type: "info",
  title: "Agent waiting for input",
  message:
    "Your agent is waiting for input. Enable notifications to get alerted when this happens.",
  actions: [
    { label: "Enable notifications", variant: "primary" },
    { label: "No thanks", variant: "secondary" },
  ],
  expect: "Your agent is waiting for input",
};
const FORGE: Fixture = {
  type: "info",
  title: "GitHub integration is off",
  message:
    "This repository is hosted on GitHub, but the GitHub plugin is disabled — issues, pull requests, and repo stats are unavailable.",
  actions: [
    { label: "Enable GitHub", variant: "primary" },
    { label: "Not now", variant: "secondary" },
  ],
  expect: "This repository is hosted on GitHub",
};
const MEMORY: Fixture = {
  type: "warning",
  title: "High system memory use",
  message:
    "Swap is 87% full and the fseventsd process is using 2.4 GB of memory. Restarting your Mac clears this.",
  expect: "Swap is 87% full",
};
const STALLED: Fixture = {
  type: "warning",
  title: "Terminal output stalled",
  message: "Reset the queue from the terminal banner to recover.",
  expect: "Reset the queue",
};
const ERROR: Fixture = {
  type: "error",
  title: "Couldn't start the dev server",
  message: "Port 5173 is already in use by another process.",
  actions: [{ label: "Retry", variant: "primary" }],
  expect: "Port 5173",
};
const RECOVERED: Fixture = {
  type: "success",
  title: "System memory readings recovered",
  message: "Every monitored reading has stayed below its threshold for three samples in a row.",
  expect: "Every monitored reading",
};
const UNTITLED: Fixture = {
  type: "info",
  message: "Terminal output resumed.",
  expect: "Terminal output resumed",
};

const failures: string[] = [];

async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).slice(0, 300);
    console.warn(`[gridbar-shots] step "${name}" failed:`, detail);
    failures.push(`${name}: ${detail}`);
  } finally {
    await resetMedia(page).catch(() => {});
    await page.mouse.move(2, 400).catch(() => {});
  }
}

let mediaSession: CDPSession | null = null;

async function setMediaFeatures(
  page: Page,
  features: { name: string; value: string }[]
): Promise<void> {
  mediaSession ??= await page.context().newCDPSession(page);
  await mediaSession.send("Emulation.setEmulatedMedia", { features });
  for (const f of features) {
    const query = `(${f.name}: ${f.value})`;
    const matches = await page.evaluate((q) => window.matchMedia(q).matches, query);
    if (!matches) throw new Error(`media emulation did not apply: ${query}`);
  }
}

async function resetMedia(page: Page): Promise<void> {
  if (mediaSession) {
    await mediaSession.send("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
  }
  await page.emulateMedia({ forcedColors: null }).catch(() => {});
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/**
 * Clear the slot, inject one fixture, and wait until the live region carries
 * its text and the bar has opened to full height. The swap path clears the
 * live region for ~150ms before repopulating, so reading too early captures an
 * empty bar — which is the wrong artifact this throws on.
 */
async function show(page: Page, fixture: Fixture): Promise<void> {
  await resetNotifications(page);
  await page
    .locator(STATUS)
    .filter({ hasText: /\S/ })
    .waitFor({ state: "detached", timeout: 2000 })
    .catch(() => {});
  await settle(page, 300);
  const { expect: text, ...opts } = fixture;
  await injectGridNotification(page, { ...opts, duration: 0 });
  await page.locator(STATUS).filter({ hasText: text }).waitFor({ timeout: 8000 });
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector<HTMLElement>(sel);
      return !!el && el.getBoundingClientRect().height > 24 && getComputedStyle(el).opacity === "1";
    },
    BAR,
    { timeout: 5000 }
  );
  await settle(page, 300);
}

/** The bar plus a band of the grid beneath it, so it is judged in place. */
async function snapBar(page: Page, slug: string, below = 120): Promise<void> {
  await settle(page);
  const box = await page.locator(BAR).boundingBox();
  if (!box || box.height < 24)
    throw new Error(`${slug}: grid bar not open (box ${JSON.stringify(box)})`);
  const viewport = page.viewportSize() ?? { width: 1680, height: 1050 };
  const x = Math.max(0, box.x - 12);
  const y = Math.max(0, box.y - 12);
  const clip = {
    x,
    y,
    width: Math.min(viewport.width - x, box.width + 24),
    height: Math.min(viewport.height - y, box.height + 12 + below),
  };
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${slug}.png`),
    type: "png",
    clip,
    animations: "disabled",
    caret: "hide",
  });
}

/**
 * Playwright's screenshot path re-applies its own emulation and drops the
 * hover media override, so hover shots are taken on the CDP session that set
 * it. Same clip as `snapBar`.
 */
async function snapBarViaCdp(page: Page, slug: string, below = 120): Promise<void> {
  await settle(page);
  const box = await page.locator(BAR).boundingBox();
  if (!box || box.height < 24) throw new Error(`${slug}: grid bar not open`);
  mediaSession ??= await page.context().newCDPSession(page);
  const { data } = await mediaSession.send("Page.captureScreenshot", {
    format: "png",
    clip: {
      x: Math.max(0, box.x - 12),
      y: Math.max(0, box.y - 12),
      width: box.width + 24,
      height: box.height + 12 + below,
      scale: 1,
    },
  });
  writeFileSync(path.join(OUTPUT_DIR, `${slug}.png`), Buffer.from(data, "base64"));
}

async function snapWindow(page: Page, slug: string): Promise<void> {
  await settle(page);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${slug}.png`),
    type: "png",
    animations: "disabled",
    caret: "hide",
  });
}

/**
 * Tailwind v4 wraps `hover:` in `@media (hover: hover)`, which a driven
 * Electron window can report as unmatched — every hover shot then comes out
 * identical to rest. Force the media feature on, hover, and throw unless the
 * control's paint actually changed.
 */
async function hoverAndVerify(page: Page, name: string): Promise<void> {
  if (!(await page.evaluate(() => matchMedia("(hover: hover)").matches))) {
    await setMediaFeatures(page, [{ name: "hover", value: "hover" }]);
  }
  const button = page.locator(BAR).getByRole("button", { name });
  const paint = () =>
    button.evaluate((el) => {
      const cs = getComputedStyle(el);
      return `${cs.backgroundColor}|${cs.color}|${cs.borderColor}|${cs.boxShadow}`;
    });
  await page.mouse.move(2, 400);
  await settle(page, 150);
  const rest = await paint();
  await button.hover();
  await settle(page, 150);
  if (!(await button.evaluate((el) => el.matches(":hover")))) {
    throw new Error(`hover: pointer is not over "${name}"`);
  }
  if ((await paint()) === rest) throw new Error(`hover: "${name}" painted no hover state`);
}

async function measure(page: Page, label: string): Promise<void> {
  geometry[label] = await page.evaluate((sel) => {
    const bar = document.querySelector<HTMLElement>(sel);
    if (!bar) return null;
    const card = bar.firstElementChild as HTMLElement | null;
    const buttons = Array.from(bar.querySelectorAll<HTMLElement>("button")).map((b) => {
      const r = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      return {
        name: b.getAttribute("aria-label") ?? b.textContent?.trim(),
        w: Math.round(r.width),
        h: Math.round(r.height),
        color: cs.color,
        bg: cs.backgroundColor,
        border: cs.borderColor,
      };
    });
    const status = bar.querySelector<HTMLElement>("[role='status']");
    const texts = status
      ? Array.from(status.querySelectorAll<HTMLElement>("p, div")).map((n) => ({
          text: n.textContent?.slice(0, 40),
          color: getComputedStyle(n).color,
          font: getComputedStyle(n).font,
        }))
      : [];
    const r = card?.getBoundingClientRect();
    return {
      card: r ? { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) } : null,
      cardBg: card ? getComputedStyle(card).backgroundColor : null,
      cardBorder: card ? getComputedStyle(card).borderColor : null,
      buttons,
      texts,
    };
  }, BAR);
}

const geometry: Record<string, unknown> = {};

async function setWindowSize(ctx: AppContext, width: number, height: number): Promise<void> {
  await ctx.app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.setSize(size.width, size.height);
    },
    { width, height }
  );
}

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-gridbar-shots-"));
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function prepareGrid(page: Page): Promise<void> {
  await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
  await dismissBlockingPalette(page);
  if ((await page.locator(SEL.panel.gridPanel).count()) < 2) {
    await openTerminal(page);
    await settle(page, 600);
    await openTerminal(page);
  }
  await page.locator(SEL.panel.gridPanel).nth(1).waitFor({ state: "visible", timeout: T_LONG });
  await settle(page, 1200);
  await dismissBlockingPalette(page);
}

const SPOT_THEMES = ["daintree", "namib", "svalbard", "bali"];

test("grid notification bar review — severities, actions, wrapping, themes", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_GRIDBAR is required for the grid bar capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_GRIDBAR to run the grid bar capture");
  test.setTimeout(10 * 60_000);

  failures.length = 0;
  mediaSession = null;
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-gridbarshot-"));
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await prepareGrid(page);

    await step(page, "severities", async () => {
      const set: [string, Fixture][] = [
        ["01-info-waiting-two-actions", WAITING],
        ["02-info-forge-two-actions-long", FORGE],
        ["03-warning-memory-long-no-actions", MEMORY],
        ["04-warning-stalled-short", STALLED],
        ["05-error-one-action", ERROR],
        ["06-success-recovered", RECOVERED],
        ["07-info-untitled", UNTITLED],
      ];
      for (const [slug, fixture] of set) {
        await show(page, fixture);
        await measure(page, slug);
        await snapBar(page, slug);
      }
    });

    await step(page, "focus", async () => {
      await show(page, WAITING);
      await page.locator(BAR).getByRole("button", { name: "Enable notifications" }).focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await snapBar(page, "20-focus-primary-action", 40);
      await page.locator(BAR).getByRole("button", { name: "Dismiss" }).focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await snapBar(page, "21-focus-dismiss", 40);
    });

    await step(page, "hover", async () => {
      await show(page, WAITING);
      for (const [name, slug] of [
        ["No thanks", "22-hover-secondary"],
        ["Enable notifications", "23-hover-primary"],
        ["Dismiss", "24-hover-dismiss"],
      ] as const) {
        await hoverAndVerify(page, name);
        await snapBarViaCdp(page, slug, 40);
      }
    });

    await step(page, "window", async () => {
      await show(page, WAITING);
      await snapWindow(page, "30-window-waiting");
    });

    await step(page, "narrow", async () => {
      await setWindowSize(ctx!, 1100, 800);
      await settle(page, 800);
      await show(page, FORGE);
      await measure(page, "40-narrow-forge");
      await snapBar(page, "40-narrow-forge-two-actions");
      await show(page, WAITING);
      await snapBar(page, "41-narrow-waiting-two-actions");
      await setWindowSize(ctx!, 860, 760);
      await settle(page, 800);
      await show(page, FORGE);
      await measure(page, "42-narrower-forge");
      await snapBar(page, "42-narrower-forge-two-actions");
      await show(page, STALLED);
      await snapBar(page, "43-narrower-no-actions");
      await setWindowSize(ctx!, 1680, 1050);
      await settle(page, 800);
    });

    await step(page, "contrast", async () => {
      await setMediaFeatures(page, [{ name: "prefers-contrast", value: "more" }]);
      await show(page, WAITING);
      await snapBar(page, "90-high-contrast-waiting", 40);
      await show(page, MEMORY);
      await snapBar(page, "91-high-contrast-warning", 40);
    });

    await step(page, "forced", async () => {
      await page.emulateMedia({ forcedColors: "active" });
      await settle(page, 400);
      if (!(await page.evaluate(() => matchMedia("(forced-colors: active)").matches))) {
        throw new Error("forced-colors emulation did not apply");
      }
      await show(page, WAITING);
      await snapBar(page, "92-forced-colors-waiting", 40);
      await show(page, ERROR);
      await snapBar(page, "93-forced-colors-error", 40);
    });

    await step(page, "themes", async () => {
      for (const [i, theme] of SPOT_THEMES.entries()) {
        await setAppTheme(page, theme);
        await prepareGrid(page);
        await show(page, WAITING);
        await measure(page, `95-theme-${theme}-waiting`);
        await snapBar(page, `95-theme-${i}-${theme}-waiting`, 60);
        await show(page, MEMORY);
        await snapBar(page, `96-theme-${i}-${theme}-warning`, 60);
        await show(page, ERROR);
        await snapBar(page, `97-theme-${i}-${theme}-error`, 60);
      }
    });
  } finally {
    if (ctx?.app) await closeApp(ctx.app).catch(() => {});
    try {
      repo.cleanup();
    } catch {
      /* best effort */
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  if (Object.keys(geometry).length > 0) {
    writeFileSync(
      path.join(OUTPUT_DIR, "geometry.json"),
      JSON.stringify(geometry, null, 2),
      "utf8"
    );
  }

  const written = existsSync(OUTPUT_DIR)
    ? readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")).length
    : 0;
  console.warn(`[gridbar-shots] wrote ${written} png(s) to ${OUTPUT_DIR}`);

  if (failures.length > 0) {
    throw new Error(`[gridbar-shots] ${failures.length} step(s) failed:\n${failures.join("\n")}`);
  }
  if (written === 0) {
    throw new Error(`[gridbar-shots] no PNGs written to ${OUTPUT_DIR}`);
  }
});
