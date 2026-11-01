/**
 * Schedules view visual-review harness (#15984).
 *
 * Boots a real project with a second worktree, captures the empty view, then
 * seeds schedules through the real store (`window.electron.schedules.create`
 * from the project's own view, the only sender main accepts) and walks the
 * list, the editor for a new and an existing schedule, validation and the
 * delete confirmation. A custom Claude preset that skips permission prompts
 * is seeded through agent settings, so the editor shows the permission
 * warning for the bare agent and not for the preset.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_SCHEDULES=1 DAINTREE_SHOT_THEME=daintree,bondi \
 *     npx playwright test --project=screenshots schedules-view-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SCHEDULES  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME      comma-separated theme ids (default: daintree)
 *   DAINTREE_SHOT_TAG        optional suffix, to keep rounds side by side
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 2)
 *   DESIGN_CAPTURE_DIR       optional output directory
 *
 * Output: artifacts/schedules-shots/<theme>-<NN-slug>[-tag].png (gitignored),
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

const ENABLED = !!process.env.DAINTREE_SHOT_SCHEDULES;
const THEMES = (process.env.DAINTREE_SHOT_THEME ?? "daintree")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : path.resolve(process.cwd(), "artifacts", "schedules-shots");

const DIALOG = '[data-testid="schedules-dialog"]';
const UNATTENDED_PRESET = "schedules-shot-unattended";

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

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createRepo(root: string): { dir: string; worktreeDir: string } {
  const dir = path.join(root, "acme-api");
  mkdirSync(dir, { recursive: true });
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), "# acme-api\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  const worktreeDir = path.join(root, "acme-api-flaky-tests");
  git(`worktree add -b fix/flaky-tests "${worktreeDir}" main`, dir);
  return { dir, worktreeDir };
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function snap(page: Page, theme: string, slug: string, expect: string): Promise<void> {
  await settle(page);
  if (!(await page.locator(expect).first().isVisible())) {
    throw new Error(`${slug}: expected ${expect} to be visible before capture`);
  }
  const box = await page.locator(DIALOG).first().boundingBox();
  if (!box) throw new Error(`${slug}: dialog has no box`);
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

/** Scroll the dialog body to its end, so the lower sections of the editor are in frame. */
async function scrollBodyToEnd(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    const dialog = document.querySelector(selector);
    if (!dialog) throw new Error("schedules dialog missing");
    const scrollers = [...dialog.querySelectorAll<HTMLElement>("*")].filter(
      (el) => el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== "visible"
    );
    const body = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    if (!body) throw new Error("schedules dialog has nothing to scroll");
    body.scrollTop = body.scrollHeight;
  }, DIALOG);
}

async function openView(page: Page, scheduleId?: string): Promise<void> {
  const result = await dispatchAction(
    page,
    "schedules.open",
    scheduleId ? { scheduleId } : undefined,
    {
      source: "user",
    }
  );
  if (!result.ok) throw new Error(`schedules.open failed: ${JSON.stringify(result)}`);
  await page.locator(DIALOG).waitFor({ state: "visible", timeout: 8000 });
}

async function closeView(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  // A page with unsaved edits asks before it lets go.
  const discard = page.getByRole("button", { name: "Discard changes" });
  if (await discard.isVisible({ timeout: 1000 }).catch(() => false)) await discard.click();
  await page.locator(DIALOG).waitFor({ state: "detached", timeout: 8000 });
  await settle(page, 200);
}

async function seedPreset(page: Page): Promise<void> {
  await page.evaluate(async (presetId) => {
    type Entry = Record<string, unknown>;
    const settings = (await window.electron.agentSettings.get()) as {
      agents?: Record<string, Entry | undefined>;
    };
    const entry = settings.agents?.claude ?? {};
    await window.electron.agentSettings.set("claude", {
      ...entry,
      customPresets: [
        {
          id: presetId,
          name: "Unattended",
          description: "Skips permission prompts for runs nobody is watching",
          dangerousMode: "on",
        },
      ],
    });
  }, UNATTENDED_PRESET);
}

/** Five schedules covering the list's shapes; returns the ids the walk opens. */
async function seedSchedules(page: Page): Promise<{ first: string; withCheck: string }> {
  const worktreeId = await page.evaluate(async () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const all = (await window.electron.worktree.getAll()) as Array<{
        id: string;
        isMainWorktree?: boolean;
      }>;
      const other = all.find((worktree) => !worktree.isMainWorktree);
      if (other) return other.id;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("second worktree never appeared");
  });

  return page.evaluate(
    async ({ worktreeId, presetId }) => {
      const make = async (input: Parameters<typeof window.electron.schedules.create>[0]) => {
        const outcome = await window.electron.schedules.create(input);
        if (outcome.status !== "saved") throw new Error(JSON.stringify(outcome));
        return outcome.schedule;
      };
      const first = await make({
        name: "Nightly dependency check",
        cron: "0 2 * * *",
        launch: {
          agentId: "claude",
          presetId,
          prompt:
            "Check for outdated dependencies, update the ones with no breaking changes, run the tests, and open a pull request with what changed.",
        },
      });
      await make({
        name: "Weekday PR triage",
        cron: "0 9 * * 1-5",
        launch: {
          agentId: "codex",
          prompt:
            "Summarise every open pull request that's waiting on review and who it's waiting on.",
        },
        policies: { onDone: "background" },
      });
      const withCheck = await make({
        name: "Flaky test sweep",
        cron: "*/30 * * * *",
        launch: {
          agentId: "claude",
          presetId,
          worktreeId,
          prompt:
            "Run the integration suite three times and file what failed only some of the time.",
        },
        policies: {
          overlap: "replace",
          precondition: { command: "git fetch -q && ! git diff --quiet HEAD @{u}" },
        },
      });
      const paused = await make({
        name: "Monthly licence audit",
        cron: "0 10 1 * *",
        launch: {
          agentId: "claude",
          prompt: "List every dependency whose licence changed this month.",
        },
      });
      await window.electron.schedules.setEnabled(paused.id, false);
      await make({
        name: "Rebuild the documentation search index and post the broken-link report to the team channel",
        cron: "15 3 */2 * 1-5",
        launch: {
          agentId: "claude",
          prompt: "Rebuild the docs search index, then report broken links.",
        },
        policies: { missedRuns: "skip" },
      });
      return { first: first.id, withCheck: withCheck.id };
    },
    { worktreeId, presetId: UNATTENDED_PRESET }
  );
}

test("schedules view review — every state, per theme", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SCHEDULES is required for the schedules capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_SCHEDULES=1 to run this capture");
  test.setTimeout(10 * 60_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const theme of THEMES) {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "daintree-schedshot-repos-"));
    const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-schedshot-"));
    const { dir } = createRepo(repoRoot);
    let ctx: AppContext | undefined;
    try {
      ctx = await launchApp({
        userDataDir,
        screenshotScale: SCALE,
        windowSize: { width: 1680, height: 1050 },
        extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
      });
      const page = await openAndOnboardProject(ctx.app, ctx.window, dir, "Acme API");
      await seedPreset(page);
      await setAppTheme(page, theme);
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await dismissBlockingPalette(page);
      await page
        .locator(SEL.worktree.mainCard)
        .waitFor({ state: "visible", timeout: T_LONG })
        .catch(() => {});
      await settle(page, 800);

      // 01 — no schedules yet: what a schedule is, and the way to make one.
      await openView(page);
      await snap(page, theme, "01-empty", `${DIALOG} >> text=Run an agent on a schedule`);
      await closeView(page);

      const { first: firstId, withCheck } = await seedSchedules(page);
      await settle(page, 300);

      // 02 — the list: on, paused, every-N, custom cron, another worktree, a long name.
      await openView(page);
      await snap(page, theme, "02-list", `${DIALOG} >> text=Monthly licence audit`);

      // 03 — a new schedule: #15974's defaults, and the bare agent's permission warning.
      await page.getByRole("button", { name: "New schedule" }).first().click();
      await snap(
        page,
        theme,
        "03-new-top",
        `${DIALOG} >> text=This run will stop at permission prompts`
      );

      // 04 — Create with nothing filled in and a cron out of range: every field says what's wrong.
      const cadence = page.locator(`${DIALOG} input[placeholder="0 9 * * *"]`);
      await cadence.fill("61 9 * * *");
      await page.getByRole("button", { name: "Create schedule" }).click();
      await snap(page, theme, "04-new-invalid", `${DIALOG} >> text=Name the schedule`);
      await scrollBodyToEnd(page);
      await snap(
        page,
        theme,
        "05-new-invalid-bottom",
        `${DIALOG} >> text=When the agent reports done`
      );
      await closeView(page);

      // 06 — an existing schedule opened straight to its page, as another surface would.
      await openView(page, firstId);
      await snap(page, theme, "06-edit-top", `${DIALOG} >> text=Nightly dependency check`);
      await scrollBodyToEnd(page);
      await snap(page, theme, "07-edit-bottom", `${DIALOG} >> text=Delete schedule…`);

      // 08 — delete asks first, naming the schedule.
      await page.getByRole("button", { name: "Delete schedule…" }).click();
      await page.getByRole("alertdialog").waitFor({ state: "visible", timeout: 5000 });
      await snap(page, theme, "08-delete-confirm", '[role="alertdialog"]');
      await page.keyboard.press("Escape");
      await page.getByRole("alertdialog").waitFor({ state: "detached", timeout: 5000 });

      // 09 — an edit, then Back: the draft isn't thrown away without asking.
      await page
        .locator(`${DIALOG} [data-schedule-focus="name"]`)
        .fill("Nightly dependency check and audit");
      await page.getByRole("button", { name: "Back to schedules" }).click();
      await page.getByRole("alertdialog").waitFor({ state: "visible", timeout: 5000 });
      await snap(page, theme, "09-discard-confirm", '[role="alertdialog"]');
      await page.getByRole("button", { name: "Discard changes" }).click();
      await page.getByRole("alertdialog").waitFor({ state: "detached", timeout: 5000 });
      await closeView(page);

      // 10 — a schedule with its precondition on, another worktree and Replace.
      await openView(page, withCheck);
      await scrollBodyToEnd(page);
      await snap(
        page,
        theme,
        "10-check-on-bottom",
        `${DIALOG} >> text=Runs in a shell in the schedule's worktree`
      );
      await closeView(page);
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      for (const target of [repoRoot, userDataDir]) {
        if (!existsSync(target)) continue;
        try {
          rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch (error) {
          console.warn(
            `[schedule-shots] could not remove ${target}:`,
            String(error).split("\n")[0]
          );
        }
      }
    }
  }
});
