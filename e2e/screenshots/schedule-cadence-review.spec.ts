/**
 * Schedule cadence picker visual-review harness (#15985).
 *
 * Boots a real project, seeds one schedule per cadence the picker writes and
 * two it can only show as custom (through `window.electron.schedules.create`
 * from the project's own view, the only sender main accepts), then opens each
 * one at its page with "When it runs" in frame: every preset, custom with and
 * without a reading, the kind, interval and time lists open, no day chosen,
 * the 31st, a bad expression, a switch to custom, and a schedule made in
 * another time zone.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_CADENCE=1 DAINTREE_SHOT_THEME=daintree,bondi \
 *     npx playwright test --project=screenshots schedule-cadence-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_CADENCE      required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME        comma-separated theme ids (default: daintree)
 *   DAINTREE_SHOT_TAG          optional suffix, to keep rounds side by side
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 2)
 *   DESIGN_CAPTURE_DIR         optional output directory
 *
 * Output: artifacts/cadence-shots/<theme>-<NN-slug>[-tag].png (gitignored),
 * or DESIGN_CAPTURE_DIR when set.
 */

import { test, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { dispatchAction } from "../helpers/actions";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_CADENCE;
const THEMES = (process.env.DAINTREE_SHOT_THEME ?? "daintree")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : path.resolve(process.cwd(), "artifacts", "cadence-shots");

const DIALOG = '[data-testid="schedules-dialog"]';
const PREVIEW = '[data-testid="schedule-cadence-preview"]';

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

/** Each seeded schedule, by the cadence its page opens in. */
const SEEDS = {
  daily: { name: "Nightly dependency check", cron: "0 2 * * *" },
  weekdays: { name: "Weekday PR triage", cron: "0 9 * * 1-5" },
  interval: { name: "Flaky test sweep", cron: "*/30 * * * *" },
  days: { name: "Release notes draft", cron: "30 17 * * 1,3,5" },
  monthly: { name: "Monthly licence audit", cron: "0 10 1 * *" },
  customRead: { name: "January planning", cron: "0 9 * 1 *" },
  customUnread: { name: "Docs index rebuild", cron: "15 3 */2 * 1-5" },
  foreign: { name: "Standup notes", cron: "0 9 * * 1-5", timeZone: "America/New_York" },
} as const satisfies Record<string, { name: string; cron: string; timeZone?: string }>;
type SeedKey = keyof typeof SEEDS;

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

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/** The dialog, widened to take in any open list that spills past it. */
async function captureBox(page: Page, slug: string) {
  const boxes = [await page.locator(DIALOG).first().boundingBox()];
  for (const popper of await page.locator("[data-radix-popper-content-wrapper]").all()) {
    if (await popper.isVisible()) boxes.push(await popper.boundingBox());
  }
  const real = boxes.filter((b): b is NonNullable<typeof b> => b !== null);
  if (real.length === 0) throw new Error(`${slug}: dialog has no box`);
  const left = Math.min(...real.map((b) => b.x));
  const top = Math.min(...real.map((b) => b.y));
  const right = Math.max(...real.map((b) => b.x + b.width));
  const bottom = Math.max(...real.map((b) => b.y + b.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

async function snap(page: Page, theme: string, slug: string, expect: string): Promise<void> {
  await settle(page);
  if (!(await page.locator(expect).first().isVisible())) {
    throw new Error(`${slug}: expected ${expect} to be visible before capture`);
  }
  const box = await captureBox(page, slug);
  const pad = 24;
  const viewport = page.viewportSize() ?? { width: 1680, height: 1050 };
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const file = path.join(OUTPUT_DIR, `${theme}-${slug}${TAG}.png`);
  await page.screenshot({
    path: file,
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: {
      x,
      y,
      width: Math.min(box.width + pad * 2, viewport.width - x),
      height: Math.min(box.height + pad * 2, viewport.height - y),
    },
  });
  if (!existsSync(file) || statSync(file).size < 4000) {
    throw new Error(`${slug}: capture missing or implausibly small`);
  }
}

/** Scrolls the editor so "When it runs" sits at the top of the dialog body. */
async function showCadence(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    const dialog = document.querySelector(selector);
    const heading = [...(dialog?.querySelectorAll<HTMLElement>(".settings-section") ?? [])].find(
      (section) => section.textContent?.startsWith("When it runs")
    );
    if (!heading) throw new Error("When it runs section missing");
    heading.scrollIntoView({ block: "start" });
  }, DIALOG);
  await page.locator(PREVIEW).waitFor({ state: "visible", timeout: 5000 });
}

async function openSchedule(page: Page, scheduleId: string): Promise<void> {
  const result = await dispatchAction(page, "schedules.open", { scheduleId }, { source: "user" });
  if (!result.ok) throw new Error(`schedules.open failed: ${JSON.stringify(result)}`);
  await page.locator(DIALOG).waitFor({ state: "visible", timeout: 8000 });
  // A schedule opens on its runs (#15986); the cadence is on its editor.
  await page.locator(DIALOG).getByRole("button", { name: "Edit schedule" }).click();
  await showCadence(page);
}

async function closeView(page: Page): Promise<void> {
  // An open list takes the first Escape.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await page.locator(DIALOG).isVisible())) break;
    await page.keyboard.press("Escape");
    const discard = page.getByRole("button", { name: "Discard changes" });
    if (await discard.isVisible({ timeout: 600 }).catch(() => false)) await discard.click();
    await settle(page, 150);
  }
  await page.locator(DIALOG).waitFor({ state: "detached", timeout: 8000 });
  await settle(page, 200);
}

async function pick(page: Page, combobox: string, option: string): Promise<void> {
  await page.locator(DIALOG).getByRole("combobox", { name: combobox }).click();
  await page.getByRole("option", { name: option }).click();
  await settle(page, 150);
}

async function seedSchedules(page: Page): Promise<Record<SeedKey, string>> {
  return page.evaluate(async (seeds) => {
    const ids: Record<string, string> = {};
    for (const [key, seed] of Object.entries(seeds)) {
      const outcome = await window.electron.schedules.create({
        name: seed.name,
        cron: seed.cron,
        ...("timeZone" in seed ? { timeZone: seed.timeZone } : {}),
        launch: { agentId: "claude", prompt: `Run the ${seed.name.toLowerCase()}.` },
      });
      if (outcome.status !== "saved") throw new Error(JSON.stringify(outcome));
      ids[key] = outcome.schedule.id;
    }
    return ids as Record<keyof typeof seeds, string>;
  }, SEEDS);
}

test("schedule cadence picker review — every kind and state, per theme", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_CADENCE is required for the cadence capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_CADENCE=1 to run this capture");
  test.setTimeout(10 * 60_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const theme of THEMES) {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "daintree-cadenceshot-repos-"));
    const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-cadenceshot-"));
    const dir = createRepo(repoRoot);
    let ctx: AppContext | undefined;
    try {
      ctx = await launchApp({
        userDataDir,
        screenshotScale: SCALE,
        windowSize: { width: 1680, height: 1050 },
        extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
      });
      const page = await openAndOnboardProject(ctx.app, ctx.window, dir, "Acme API");
      await setAppTheme(page, theme);
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await dismissBlockingPalette(page);
      await page
        .locator(SEL.worktree.mainCard)
        .waitFor({ state: "visible", timeout: T_LONG })
        .catch(() => {});
      await settle(page, 800);
      const ids = await seedSchedules(page);
      await settle(page, 300);

      // 01-07 — each schedule opens in the picker state that wrote it, or as custom.
      const opened: [string, SeedKey, string][] = [
        ["01-daily", "daily", "Every day at 2:00 AM"],
        ["02-weekdays", "weekdays", "Weekdays at 9:00 AM"],
        ["03-interval", "interval", "Every 30 minutes"],
        ["04-days", "days", "Mondays, Wednesdays and Fridays at 5:30 PM"],
        ["05-monthly", "monthly", "On the 1st of the month at 10:00 AM"],
        ["06-custom-read", "customRead", "Every day at 9:00 AM in January"],
        ["07-custom-unread", "customUnread", "Runs on a custom schedule"],
      ];
      for (const [slug, key, words] of opened) {
        await openSchedule(page, ids[key]);
        await snap(page, theme, slug, `${PREVIEW} >> text=${words}`);
        await closeView(page);
      }

      // 08 — the kind list, open over a daily schedule.
      await openSchedule(page, ids.daily);
      await page.locator(DIALOG).getByRole("combobox", { name: "Repeats" }).click();
      await snap(page, theme, "08-kind-list", '[role="option"] >> text=Custom cron expression');
      await page.keyboard.press("Escape");
      await settle(page, 150);

      // 09 — the time list.
      await page.locator(DIALOG).getByRole("button", { name: "Choose time" }).click();
      await snap(page, theme, "09-time-list", "[data-time-list]");
      await page.keyboard.press("Escape");
      await settle(page, 150);

      // 10 — switching to custom starts from the expression in use.
      await pick(page, "Repeats", "Custom cron expression");
      await snap(page, theme, "10-to-custom", `${DIALOG} input[value="0 2 * * *"]`);
      await closeView(page);

      // 11 — chosen days with every day unticked.
      await openSchedule(page, ids.days);
      for (const day of ["Monday", "Wednesday", "Friday"]) {
        await page.locator(DIALOG).getByRole("checkbox", { name: day }).click();
      }
      await snap(page, theme, "11-days-none", `${DIALOG} >> text=Choose at least one day`);
      await closeView(page);

      // 12 — the 31st, which some months don't have.
      await openSchedule(page, ids.monthly);
      await pick(page, "Day of the month", "31st");
      await snap(
        page,
        theme,
        "12-monthly-31st",
        `${DIALOG} >> text=Skipped in months without a 31st`
      );
      await closeView(page);

      // 13 — a bad expression says which field is wrong.
      await openSchedule(page, ids.customUnread);
      const expression = page.locator(`${DIALOG} input[placeholder="0 9 * * *"]`);
      await expression.fill("61 9 * * *");
      await expression.press("Tab");
      await snap(page, theme, "13-custom-invalid", `${DIALOG} >> text=Minute 61 is out of range`);
      await closeView(page);

      // 14 — the interval list.
      await openSchedule(page, ids.interval);
      await page.locator(DIALOG).getByRole("combobox", { name: "Every" }).click();
      await snap(page, theme, "14-interval-list", '[role="option"] >> text=12 hours');
      await page.keyboard.press("Escape");
      await settle(page, 150);
      await closeView(page);

      // 15 — a schedule made in another zone names it beside its times.
      await openSchedule(page, ids.foreign);
      await snap(page, theme, "15-foreign-zone", `${PREVIEW} >> text=America/New_York`);
      await closeView(page);

      // 16 — an emptied hour left behind is put back, and the field says so.
      await openSchedule(page, ids.daily);
      await page.locator(`${DIALOG} [data-segment="hour"]`).click();
      await page.keyboard.press("Backspace");
      await page.locator(PREVIEW).click();
      await snap(page, theme, "16-time-incomplete", `${DIALOG} >> text=The time wasn't changed`);
      await closeView(page);
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      for (const target of [repoRoot, userDataDir]) {
        if (!existsSync(target)) continue;
        try {
          rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch (error) {
          console.warn(`[cadence-shots] could not remove ${target}:`, String(error).split("\n")[0]);
        }
      }
    }
  }
});
