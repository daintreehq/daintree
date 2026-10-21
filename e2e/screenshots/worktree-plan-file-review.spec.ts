/**
 * Worktree plan-file row visual-review harness.
 *
 * The plan-file row is the line at the foot of a worktree card's secondary
 * stack that names a plan file an agent wrote into the worktree root
 * (`TODO.md`, `PLAN.md`, `plan.md`, `TASKS.md`) and opens it in the file
 * viewer. This boots a fixture repo whose worktrees each carry a different
 * plan file, then writes PNGs of the row on the selected card and on an
 * unselected one, at rest, under hover with its tooltip, and under keyboard
 * focus, across a dark and a light theme.
 *
 * Everything goes through the app's real seams: plan detection is the
 * workspace host's own probe of the worktree root, so the fixture writes real
 * files rather than patching a store.
 *   - todo     `feature/issue-4211-stream-upload-retry`, TODO.md — the card selected for capture
 *   - plan     `fix/issue-3876-queue-drain-ordering`, PLAN.md — left unselected
 *   - tasks    `chore/archive-legacy-ingest-adapters`, TASKS.md — no derived title, so no branch line
 *   - none     `spike/columnar-export`, no plan file — the card without the row
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_PLAN_FILE is set.
 *
 *   DAINTREE_SHOT_PLAN_FILE=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     npx playwright test --project=screenshots worktree-plan-file-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PLAN_FILE  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR       output dir (default artifacts/plan-file-shots)
 *   DAINTREE_SHOT_THEMES     comma-separated themes (default daintree,svalbard)
 *   DAINTREE_SHOT_ONLY       comma-separated step filter
 *
 * Never writes a PNG it has not verified: every capture asserts its target is
 * visible with a real box and the text that makes the state this state. A
 * failing step is reported at the end and fails the run.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
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

const ENABLED = !!process.env.DAINTREE_SHOT_PLAN_FILE;
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR =
  process.env.DESIGN_CAPTURE_DIR ?? path.resolve(process.cwd(), "artifacts", "plan-file-shots");
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,svalbard")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

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

const WORKTREES = {
  todo: {
    branch: "feature/issue-4211-stream-upload-retry",
    slug: "stream-upload-retry",
    plan: "TODO.md",
  },
  plan: {
    branch: "fix/issue-3876-queue-drain-ordering",
    slug: "queue-drain",
    plan: "PLAN.md",
  },
  tasks: {
    branch: "chore/archive-legacy-ingest-adapters",
    slug: "legacy-adapters",
    plan: "TASKS.md",
  },
  none: {
    branch: "spike/columnar-export",
    slug: "columnar-export",
    plan: null,
  },
} as const;

type Key = keyof typeof WORKTREES;

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: ["pipe", "pipe", "ignore"] })
    .toString()
    .trim();
}

interface FixtureRepo {
  dir: string;
  cleanup: () => void;
}

function createFixtureRepo(): FixtureRepo {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-planshots-"));
  const worktreeRoot = path.join(path.dirname(dir), `${path.basename(dir)}-worktrees`);
  mkdirSync(worktreeRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "avery@helios.dev"', dir);
  git('config user.name "Avery Lindqvist"', dir);
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  git("add -A", dir);
  git('commit -m "Set up the ingest console skeleton"', dir);

  for (const key of Object.keys(WORKTREES) as Key[]) {
    const wt = WORKTREES[key];
    const wtDir = path.join(worktreeRoot, wt.slug);
    git(`worktree add -b ${wt.branch} "${wtDir}" main`, dir);
    if (wt.plan) {
      // Untracked, the way an agent leaves it.
      writeFileSync(
        path.join(wtDir, wt.plan),
        `# Plan\n\n- [x] Reproduce the failure\n- [ ] Write the fix\n- [ ] Cover it with a test\n`
      );
    }
  }

  return {
    dir,
    cleanup: () => {
      if (existsSync(worktreeRoot)) rmSync(worktreeRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

const written = new Set<string>();
const stepFailures: string[] = [];

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).slice(0, 500);
    stepFailures.push(`${name}: ${detail}`);
    console.warn(`[plan-shots] step "${name}" FAILED:`, detail);
  }
}

async function assertBox(target: Locator, slug: string, minW = 8, minH = 8) {
  await expect(target, `"${slug}": target never became visible — refusing to write`).toBeVisible({
    timeout: T_LONG,
  });
  const box = await target.boundingBox();
  if (!box || box.width < minW || box.height < minH) {
    throw new Error(`"${slug}": target box is ${JSON.stringify(box)} — refusing to write`);
  }
  return box;
}

async function snap(page: Page, slug: string, target: Locator, expectText?: string | RegExp) {
  await settle(page);
  await assertBox(target, slug, 40, 16);
  if (expectText !== undefined) {
    await expect(target, `"${slug}": expected content missing — refusing to write`).toContainText(
      expectText,
      { timeout: T_LONG }
    );
  }
  await target.screenshot({
    path: path.join(OUTPUT_DIR, `${slug}.png`),
    type: "png",
    animations: "disabled",
    caret: "hide",
  });
  written.add(`${slug}.png`);
}

/** Region capture covering several boxes (a card and its portalled tooltip). */
async function snapRegion(page: Page, slug: string, targets: Locator[], pad = 12) {
  await settle(page);
  const boxes = [];
  for (const t of targets) boxes.push(await assertBox(t, slug));
  const vp = page.viewportSize() ?? { width: 1680, height: 1050 };
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const right = Math.min(vp.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
  const bottom = Math.min(vp.height, Math.max(...boxes.map((b) => b.y + b.height)) + pad);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${slug}.png`),
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: { x, y, width: right - x, height: bottom - y },
  });
  written.add(`${slug}.png`);
}

const row = (page: Page, branch: string): Locator => page.locator(SEL.worktree.row(branch)).first();
const planButtonOf = (r: Locator, file: string): Locator =>
  r.locator("button").filter({ hasText: file }).first();
const openTooltip = (page: Page): Locator =>
  page.locator("[data-radix-popper-content-wrapper]").filter({ visible: true }).last();

async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(1600, 1000);
  await page.keyboard.press("Escape").catch(() => {});
  await expect(page.locator("[data-radix-popper-content-wrapper]").filter({ visible: true }))
    .toHaveCount(0, { timeout: 5_000 })
    .catch(() => {});
}

/** Real Tab presses until the target holds :focus-visible. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  await page.locator(SEL.worktree.searchInput).first().click();
  for (let i = 0; i < 150; i++) {
    await page.keyboard.press("Tab");
    const reached = await target
      .evaluate((el) => el === document.activeElement && el.matches(":focus-visible"))
      .catch(() => false);
    if (reached) return;
  }
  throw new Error("never reached :focus-visible on the plan row by Tab");
}

async function selectCard(page: Page, r: Locator, title: string, planFile: string) {
  // The title is plain text, so a click on it is a plain selection; the card's
  // top-right corner is the actions button.
  // A raw mouse click: the headline is an aria-disabled badge on an unselected
  // card, which Playwright's actionability check refuses, and the card's
  // selection is exactly what that click is meant to reach.
  const box = await r.getByText(title, { exact: true }).first().boundingBox();
  if (!box) throw new Error(`"${title}" has no box to click`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  // The click leaves the headline focused, and a ring there is not this
  // surface's state.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await settle(page, 300);
  // An unselected card's plan row names the selection step; a selected one
  // never does. Older builds name neither, so this only refuses a known miss.
  await expect(
    planButtonOf(r, planFile),
    "card never became the selected one — refusing to capture it as active"
  ).not.toHaveAttribute("aria-label", /^Select worktree/, { timeout: T_LONG });
}

test("worktree plan-file row review — states and themes", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PLAN_FILE is required for the plan-file row capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_PLAN_FILE to run the plan-file row capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-planshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await dismissBlockingPalette(page);

    const rows = Object.fromEntries(
      (Object.keys(WORKTREES) as Key[]).map((k) => [k, row(page, WORKTREES[k].branch)])
    ) as Record<Key, Locator>;

    for (const theme of THEMES) {
      await setAppTheme(page, theme);
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await dismissBlockingPalette(page);
      const t = theme;

      for (const [name, r] of Object.entries(rows)) {
        await expect(r, `worktree card "${name}" never rendered (${t})`).toBeVisible({
          timeout: T_LONG,
        });
      }
      // Plan detection rides the git status pass; wait for every row to land.
      for (const key of ["todo", "plan", "tasks"] as const) {
        await expect(
          planButtonOf(rows[key], WORKTREES[key].plan),
          `${key} plan row never appeared (${t})`
        ).toBeVisible({ timeout: T_LONG * 2 });
      }
      await selectCard(page, rows.todo, "Stream upload retry", "TODO.md");
      await parkPointer(page);

      await step("rest", async () => {
        await snap(page, `${t}-10-sidebar`, page.locator(SEL.sidebar.aside).first(), "TODO.md");
        await snap(page, `${t}-11-card-active`, rows.todo, "TODO.md");
        await snap(page, `${t}-12-card-inactive`, rows.plan, "PLAN.md");
        await snap(page, `${t}-13-card-no-branch-line`, rows.tasks, "TASKS.md");
      });

      await step("hover", async () => {
        await parkPointer(page);
        let btn = planButtonOf(rows.todo, "TODO.md");
        await btn.hover();
        await page.waitForTimeout(900);
        const tipOpen = await openTooltip(page)
          .isVisible()
          .catch(() => false);
        const targets = [rows.todo];
        if (tipOpen) targets.push(openTooltip(page));
        await snapRegion(page, `${t}-20-hover-active-${tipOpen ? "tip" : "notip"}`, targets);

        await parkPointer(page);
        btn = planButtonOf(rows.plan, "PLAN.md");
        await btn.hover();
        await page.waitForTimeout(900);
        const tipOpen2 = await openTooltip(page)
          .isVisible()
          .catch(() => false);
        const targets2 = [rows.plan];
        if (tipOpen2) targets2.push(openTooltip(page));
        await snapRegion(page, `${t}-21-hover-inactive-${tipOpen2 ? "tip" : "notip"}`, targets2);
        await parkPointer(page);
      });

      // Real Tab presses: a scripted .focus() does not satisfy :focus-visible.
      await step("focus", async () => {
        await parkPointer(page);
        const btn = planButtonOf(rows.todo, "TODO.md");
        await btn.evaluate((el) => el.scrollIntoView({ block: "center" }));
        await tabTo(page, btn);
        await page.waitForTimeout(600);
        const tipOpen = await openTooltip(page)
          .isVisible()
          .catch(() => false);
        const targets = [rows.todo];
        if (tipOpen) targets.push(openTooltip(page));
        await snapRegion(page, `${t}-30-focus-active-${tipOpen ? "tip" : "notip"}`, targets);
        await page.keyboard.press("Escape");
        await page.locator(SEL.worktree.searchInput).first().click();
        await parkPointer(page);
      });
    }
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  const onDisk = readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png"));
  console.log(`[plan-shots] wrote ${written.size} shots; ${onDisk.length} PNGs on disk`);
  if (written.size === 0) throw new Error("[plan-shots] produced no screenshots at all");
  if (stepFailures.length > 0) {
    throw new Error(
      `[plan-shots] ${stepFailures.length} step(s) failed:\n${stepFailures.join("\n")}`
    );
  }
});
