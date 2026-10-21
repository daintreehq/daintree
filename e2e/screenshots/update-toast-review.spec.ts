/**
 * Update toast visual-review harness.
 *
 * Every non-Store install sees one card walk through three stages on each
 * release: available (the download has started), downloading (a determinate
 * bar), and ready (restart to install). The stages are driven through the real
 * seam: main broadcasts the same `update:*` channels `AutoUpdaterService`
 * does, so `useUpdateListener` builds every frame exactly as it does in the
 * field. Each state is verified painted (its text on screen, the card fully
 * entered) before its PNG is written; a wrong artifact throws.
 *
 * Steps (each also the DAINTREE_SHOT_ONLY filter name):
 *
 *   sequence   available → 7% → 62% → 100% → ready, one card
 *   fresh      "ready" raised with no earlier toast, and a long prerelease version
 *   focus      keyboard focus on the restart action
 *   stack      the downloading card under two other toasts
 *   inbox      the notification center entry once the toast is gone
 *   forced     `forced-colors: active`, downloading and ready
 *   themes     downloading and ready across four palettes
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_UPDATE_TOAST is set.
 *
 *   DAINTREE_SHOT_UPDATE_TOAST=1 npx playwright test --project=screenshots update-toast-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_UPDATE_TOAST  required — any truthy value runs the capture
 *   DAINTREE_SHOT_ONLY          comma-separated step filter (see step names above)
 *   DESIGN_CAPTURE_DIR          optional output dir, so review rounds write outside the tree
 *
 * Output: artifacts/update-toast-shots/<NN-slug>.png (gitignored).
 */

import { test, type ElectronApplication, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { openTerminal } from "../helpers/panels";
import { injectToast, resetNotifications } from "../helpers/notifications";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_UPDATE_TOAST;
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : path.resolve(process.cwd(), "artifacts", "update-toast-shots");

const REGION = SEL.notifications.toastRegion;
const VERSION = "0.42.0";
const LONG_VERSION = "0.43.0-beta.12";

const POLISH_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

const failures: string[] = [];

async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).slice(0, 300);
    console.warn(`[update-toast-shots] step "${name}" failed:`, detail);
    failures.push(`${name}: ${detail}`);
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
    await page.emulateMedia({ forcedColors: null }).catch(() => {});
    await page.mouse.move(400, 700).catch(() => {});
  }
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/** Send an update channel the way `broadcastToRenderer` does: to every live webContents. */
async function broadcast(app: ElectronApplication, channel: string, payload: unknown) {
  await app.evaluate(
    ({ webContents }, { channel, payload }) => {
      for (const wc of webContents.getAllWebContents()) {
        if (!wc.isDestroyed()) wc.send(channel, payload);
      }
    },
    { channel, payload }
  );
}

const available = (app: ElectronApplication, version = VERSION) =>
  broadcast(app, "update:available", { version });
const progress = (app: ElectronApplication, percent: number) =>
  broadcast(app, "update:download-progress", { percent });
const downloaded = (app: ElectronApplication, version = VERSION) =>
  broadcast(app, "update:downloaded", { version });

/** Wait until the region shows `text` and every card has finished entering. */
async function painted(page: Page, text: string | RegExp, cards = 1): Promise<void> {
  await page.locator(REGION).getByText(text).first().waitFor({ timeout: 8000 });
  await page.waitForFunction(
    ({ sel, n }) => {
      const region = document.querySelector<HTMLElement>(sel);
      if (!region) return false;
      const all = Array.from(region.querySelectorAll<HTMLElement>(":scope > [data-toast]"));
      return all.length === n && all.every((c) => getComputedStyle(c).opacity === "1");
    },
    { sel: REGION, n: cards },
    { timeout: 5000 }
  );
  await settle(page, 250);
}

/** Bar width must match the percent it claims, or the frame is lying. */
async function barAt(page: Page, percent: number): Promise<void> {
  await page.waitForFunction(
    ({ sel, pct }) => {
      const bar = document.querySelector<HTMLElement>(`${sel} [role="progressbar"]`);
      const fill = bar?.firstElementChild as HTMLElement | null;
      if (!bar || !fill) return false;
      const ratio = fill.getBoundingClientRect().width / bar.getBoundingClientRect().width;
      return Math.abs(ratio * 100 - pct) < 1.5;
    },
    { sel: REGION, pct: percent },
    { timeout: 5000 }
  );
}

async function clear(page: Page): Promise<void> {
  await resetNotifications(page);
  await page
    .locator(REGION)
    .waitFor({ state: "detached", timeout: 3000 })
    .catch(() => {});
  await settle(page, 200);
}

async function regionClip(page: Page, below: number) {
  const box = await page.locator(REGION).boundingBox();
  if (!box || box.height < 40) throw new Error(`toast region not open (${JSON.stringify(box)})`);
  const viewport = page.viewportSize() ?? { width: 1680, height: 1050 };
  const x = Math.max(0, box.x - 40);
  const y = Math.max(0, box.y - 16);
  return {
    x,
    y,
    width: Math.min(viewport.width - x, box.width + 40),
    height: Math.min(viewport.height - y, box.height + 16 + below),
  };
}

async function snap(page: Page, slug: string, below = 40): Promise<void> {
  await settle(page);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${slug}.png`),
    type: "png",
    clip: await regionClip(page, below),
    animations: "disabled",
    caret: "hide",
  });
}

const textLog: Record<string, unknown> = {};

/** Record what the card says, visibly and to a screen reader, beside each shot. */
async function record(page: Page, slug: string): Promise<void> {
  textLog[slug] = await page.evaluate((sel) => {
    const region = document.querySelector<HTMLElement>(sel);
    return Array.from(region?.querySelectorAll<HTMLElement>(":scope > [data-toast]") ?? []).map(
      (card) => {
        const live = card.querySelector<HTMLElement>('[role="status"],[role="alert"]');
        const bar = card.querySelector<HTMLElement>('[role="progressbar"]');
        return {
          visible: card.innerText,
          live: live?.textContent ?? null,
          height: Math.round(card.getBoundingClientRect().height),
          bar: bar
            ? {
                label: bar.getAttribute("aria-label"),
                now: bar.getAttribute("aria-valuenow"),
                text: bar.getAttribute("aria-valuetext"),
                hidden: !!bar.closest('[aria-hidden="true"]'),
              }
            : null,
        };
      }
    );
  }, REGION);
}

async function shoot(page: Page, slug: string, below = 40): Promise<void> {
  await record(page, slug);
  await snap(page, slug, below);
}

/** Walk one card from announcement to ready, shooting each stage. */
async function walk(app: ElectronApplication, page: Page, prefix: string, stages: string[]) {
  await clear(page);
  await available(app);
  await painted(page, new RegExp(VERSION.replace(/\./g, "\\.")));
  if (stages.includes("available")) await shoot(page, `${prefix}-1-available`);
  for (const pct of [7, 62, 100]) {
    await progress(app, pct);
    await barAt(page, pct);
    await settle(page, 150);
    if (stages.includes(String(pct))) await shoot(page, `${prefix}-2-downloading-${pct}`);
  }
  await downloaded(app);
  await painted(page, /restart/i);
  if (stages.includes("ready")) await shoot(page, `${prefix}-3-ready`);
}

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-update-toast-shots-"));
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

test("update toast review — available, downloading, ready", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_UPDATE_TOAST is required for the update toast capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_UPDATE_TOAST to run the update toast capture");
  test.setTimeout(10 * 60_000);

  failures.length = 0;
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-updatetoastshot-"));
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const app = ctx.app;
    const page = await openAndOnboardProject(app, ctx.window, repo.dir, "Helios Dashboard");
    await prepareGrid(page);

    await step(page, "sequence", async () => {
      await walk(app, page, "0", ["available", "7", "62", "100", "ready"]);
    });

    await step(page, "fresh", async () => {
      await clear(page);
      await downloaded(app, LONG_VERSION);
      await painted(page, /restart/i);
      await shoot(page, "10-ready-fresh-prerelease");
    });

    await step(page, "focus", async () => {
      await walk(app, page, "x", []);
      const button = page.locator(REGION).getByRole("button", { name: /restart/i });
      await button.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      if (!(await button.evaluate((el) => el.matches(":focus-visible")))) {
        throw new Error("focus: restart action is not :focus-visible");
      }
      await shoot(page, "20-ready-focus-restart");
    });

    await step(page, "stack", async () => {
      await clear(page);
      await available(app);
      await painted(page, new RegExp(VERSION.replace(/\./g, "\\.")));
      await progress(app, 38);
      await barAt(page, 38);
      await injectToast(page, {
        type: "success",
        title: "Claude finished",
        message: "Refactored the checkout form in helios-dashboard/feature-checkout.",
        actions: [{ label: "Open review", variant: "primary" }],
        duration: 0,
      });
      await injectToast(page, {
        type: "error",
        title: "Push failed",
        message:
          "The remote rejected feature/checkout-redesign because it has commits you don't have. Pull first, then push again.",
        actions: [{ label: "Pull and rebase", variant: "primary" }],
        duration: 0,
      });
      await painted(page, "The remote rejected", 3);
      await shoot(page, "30-downloading-in-stack", 40);
    });

    await step(page, "inbox", async () => {
      await walk(app, page, "y", []);
      await page.locator(REGION).getByRole("button", { name: "Dismiss notification" }).click();
      await page
        .locator(REGION)
        .waitFor({ state: "detached", timeout: 3000 })
        .catch(() => {});
      await page.locator(SEL.notifications.bellButton).first().click();
      const dialog = page.getByRole("dialog").last();
      await dialog
        .getByText(new RegExp(VERSION.replace(/\./g, "\\.")))
        .first()
        .waitFor({
          timeout: 5000,
        });
      await settle(page, 400);
      const box = await dialog.boundingBox();
      if (!box) throw new Error("inbox: notification center not open");
      await page.screenshot({
        path: path.join(OUTPUT_DIR, "40-inbox-entry.png"),
        type: "png",
        clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 420) },
        animations: "disabled",
        caret: "hide",
      });
      await page.keyboard.press("Escape");
    });

    await step(page, "forced", async () => {
      await page.emulateMedia({ forcedColors: "active" });
      await settle(page, 400);
      if (!(await page.evaluate(() => matchMedia("(forced-colors: active)").matches))) {
        throw new Error("forced-colors emulation did not apply");
      }
      await walk(app, page, "92-forced", ["62", "ready"]);
    });

    await step(page, "themes", async () => {
      for (const [i, theme] of SPOT_THEMES.entries()) {
        await setAppTheme(page, theme);
        await prepareGrid(page);
        await walk(app, page, `95-theme-${i}-${theme}`, ["62", "ready"]);
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

  if (Object.keys(textLog).length > 0) {
    writeFileSync(path.join(OUTPUT_DIR, "text.json"), JSON.stringify(textLog, null, 2), "utf8");
  }

  const written = existsSync(OUTPUT_DIR)
    ? readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")).length
    : 0;
  console.warn(`[update-toast-shots] wrote ${written} png(s) to ${OUTPUT_DIR}`);

  if (failures.length > 0) {
    throw new Error(
      `[update-toast-shots] ${failures.length} step(s) failed:\n${failures.join("\n")}`
    );
  }
  if (written === 0) {
    throw new Error(`[update-toast-shots] no PNGs written to ${OUTPUT_DIR}`);
  }
});
