/**
 * Worktree activity chip visual-review harness.
 *
 * The chip is the dot + relative time at the right end of a worktree card's
 * collapsed Details row, and its hover card (`CommitInfoTooltip`). This boots a
 * fixture repo whose worktrees each put the chip in a different state, then
 * writes PNGs of the chip at rest, with its hover card open, and under keyboard
 * focus, across a dark and a light theme.
 *
 * Everything goes through the app's real seams. Activity is derived in the
 * workspace host from the last commit time and dirty-file mtimes, and the
 * author and subject come from `git log -1`, so the fixture sets real commit
 * dates and real file mtimes rather than patching a store:
 *   - fresh    dirty file touched just before capture; commit 40 minutes old
 *   - stale    clean, committed 3 hours ago by an agent identity
 *   - old      clean, committed 140 days ago; long author name and subject
 *   - anon     clean, committed 2 days ago with an empty author name, written
 *              as a literal commit object because porcelain git refuses one
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_ACTIVITY_CHIP is set.
 *
 *   DAINTREE_SHOT_ACTIVITY_CHIP=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     npx playwright test --project=screenshots worktree-activity-chip-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_ACTIVITY_CHIP  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR           output dir (default artifacts/activity-chip-shots)
 *   DAINTREE_SHOT_THEMES         comma-separated themes (default daintree,namib,svalbard,bondi)
 *   DAINTREE_SHOT_ONLY           comma-separated step filter
 *
 * Never writes a PNG it has not verified: every capture asserts its target is
 * visible with a real box and, where it matters, the text that makes the state
 * this state. A failing step is reported at the end and fails the run.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { execSync } from "child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
  utimesSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_ACTIVITY_CHIP;
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR =
  process.env.DESIGN_CAPTURE_DIR ?? path.resolve(process.cwd(), "artifacts", "activity-chip-shots");
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,namib,svalbard,bondi")
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

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const WORKTREES = {
  fresh: {
    branch: "feature/stream-upload-retry",
    slug: "stream-upload-retry",
    author: { name: "Avery Lindqvist", email: "avery@helios.dev" },
    ageSeconds: 40 * MINUTE,
    subject: "Honour Retry-After on 429 responses",
  },
  stale: {
    branch: "fix/queue-drain-ordering",
    slug: "queue-drain",
    author: { name: "Claude", email: "noreply@anthropic.com" },
    ageSeconds: 3 * HOUR,
    subject: "Drain the ingest queue in arrival order after a worker restart",
  },
  old: {
    branch: "chore/archive-legacy-ingest-adapters",
    slug: "legacy-adapters",
    author: {
      name: "Priya Raman-Oyelaran Castellanos-Whitfield",
      email: "priya.raman-oyelaran@helios.dev",
    },
    ageSeconds: 140 * DAY,
    subject:
      "Move the legacy S3, GCS and Azure Blob ingest adapters behind the archive flag so the new streaming path can own the default route without a migration window",
  },
  anon: {
    branch: "spike/columnar-export",
    slug: "columnar-export",
    author: null,
    ageSeconds: 2 * DAY,
    subject: "Imported snapshot from the export spike",
  },
} as const;

type Key = keyof typeof WORKTREES;

function git(cmd: string, cwd: string, env?: Record<string, string>): string {
  return execSync(`git ${cmd}`, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "ignore"],
  })
    .toString()
    .trim();
}

function dateEnv(ageSeconds: number): Record<string, string> {
  const stamp = `@${Math.floor(Date.now() / 1000) - ageSeconds} +0000`;
  return { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp };
}

interface FixtureRepo {
  dir: string;
  worktreeRoot: string;
  freshFile: string;
  cleanup: () => void;
}

function createFixtureRepo(): FixtureRepo {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-chipshots-"));
  const worktreeRoot = path.join(path.dirname(dir), `${path.basename(dir)}-worktrees`);
  mkdirSync(worktreeRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "avery@helios.dev"', dir);
  git('config user.name "Avery Lindqvist"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(path.join(dir, "src", "retry.ts"), "export const ATTEMPTS = 3;\n");
  git("add -A", dir);
  git('commit -m "Set up the ingest console skeleton"', dir, dateEnv(400 * DAY));

  for (const key of Object.keys(WORKTREES) as Key[]) {
    const wt = WORKTREES[key];
    const wtDir = path.join(worktreeRoot, wt.slug);
    git(`worktree add -b ${wt.branch} "${wtDir}" main`, dir);
    writeFileSync(path.join(wtDir, `${wt.slug}.md`), `# ${wt.subject}\n`);
    git("add -A", wtDir);
    if (wt.author) {
      git(
        `-c user.name="${wt.author.name}" -c user.email="${wt.author.email}" commit -m "${wt.subject}"`,
        wtDir,
        dateEnv(wt.ageSeconds)
      );
    } else {
      // Porcelain git refuses an empty ident, but a repo can still hold one
      // (imports, rewritten history). Write the object directly.
      const tree = git("write-tree", wtDir);
      const parent = git("rev-parse HEAD", wtDir);
      const ts = Math.floor(Date.now() / 1000) - wt.ageSeconds;
      const body = [
        `tree ${tree}`,
        `parent ${parent}`,
        `author <> ${ts} +0000`,
        `committer <> ${ts} +0000`,
        "",
        wt.subject,
        "",
      ].join("\n");
      const objectFile = path.join(dir, ".anon-commit");
      writeFileSync(objectFile, body);
      const sha = git(`hash-object -t commit -w --literally "${objectFile}"`, dir);
      rmSync(objectFile);
      git(`update-ref refs/heads/${wt.branch} ${sha}`, dir);
      git("reset --hard", wtDir);
    }
    // Pin every tracked file's mtime to the commit so a clean tree carries no
    // newer activity than its commit.
    const past = new Date((Math.floor(Date.now() / 1000) - wt.ageSeconds) * 1000);
    utimesSync(path.join(wtDir, `${wt.slug}.md`), past, past);
  }

  const freshFile = path.join(worktreeRoot, WORKTREES.fresh.slug, "src", "retry.ts");
  writeFileSync(
    freshFile,
    "export const ATTEMPTS = 5;\nexport const RESPECT_RETRY_AFTER = true;\n"
  );

  return {
    dir,
    worktreeRoot,
    freshFile,
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
    console.warn(`[chip-shots] step "${name}" FAILED:`, detail);
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

/** Element capture, after proving the element and its defining text exist. */
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

/** Region capture covering several boxes (a card and its portalled hover card). */
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
const chipOf = (r: Locator): Locator =>
  r.locator('[role="group"][aria-label="Last activity"]').first();
const openHoverCard = (page: Page): Locator =>
  page.locator("[data-radix-popper-content-wrapper]").filter({ visible: true }).last();

/** The collapsed Details row the chip lives on. */
const detailsRowOf = (r: Locator): Locator =>
  r.locator('[id$="-details"]').filter({ has: r.page().locator('[aria-label="Last activity"]') });

async function collapseDetails(r: Locator): Promise<void> {
  const button = r.locator('[id$="-details-button"]').first();
  if ((await button.getAttribute("aria-expanded")) === "true") {
    await button.click();
    await r.page().waitForTimeout(300);
  }
}

async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(1600, 1000);
  await page.keyboard.press("Escape").catch(() => {});
  await expect(page.locator("[data-radix-popper-content-wrapper]").filter({ visible: true }))
    .toHaveCount(0, { timeout: 5_000 })
    .catch(() => {});
}

async function hoverChip(page: Page, r: Locator, expectText: string | RegExp): Promise<Locator> {
  await parkPointer(page);
  const chip = chipOf(r);
  await chip.scrollIntoViewIfNeeded();
  await chip.hover();
  const card = openHoverCard(page);
  await expect(card, "hover card never opened").toBeVisible({ timeout: T_LONG });
  await expect(card, "hover card is not the one for this chip").toContainText(expectText, {
    timeout: T_LONG,
  });
  return card;
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
  throw new Error("never reached :focus-visible on the chip by Tab");
}

/** Rewrite the dirty file and wait for the chip to read as just-active. */
async function refreshFresh(page: Page, file: string): Promise<void> {
  writeFileSync(file, `export const ATTEMPTS = 5;\n// touched ${Date.now()}\n`);
  const now = new Date();
  utimesSync(file, now, now);
  await expect(chipOf(row(page, WORKTREES.fresh.branch)), "fresh chip never read as just-active")
    .toHaveText(/^(now|\d+s)$/, { timeout: T_LONG * 2 })
    .catch(async () => {
      // Git status is polled; a second nudge covers a poll that raced the write.
      writeFileSync(file, `export const ATTEMPTS = 5;\n// touched ${Date.now()}\n`);
      await expect(chipOf(row(page, WORKTREES.fresh.branch))).toHaveText(/^(now|\d+s|1m)$/, {
        timeout: T_LONG * 2,
      });
    });
}

test("worktree activity chip review — states and themes", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_ACTIVITY_CHIP is required for the activity chip capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_ACTIVITY_CHIP to run the activity chip capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-chipshot-"));
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

    for (const theme of THEMES) {
      await setAppTheme(page, theme);
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await dismissBlockingPalette(page);
      const t = theme;

      const rows = Object.fromEntries(
        (Object.keys(WORKTREES) as Key[]).map((k) => [k, row(page, WORKTREES[k].branch)])
      ) as Record<Key, Locator>;
      for (const [name, r] of Object.entries(rows)) {
        await expect(r, `worktree card "${name}" never rendered (${t})`).toBeVisible({
          timeout: T_LONG,
        });
        await collapseDetails(r);
      }
      // Wait for git status so each chip is showing its derived value, not a
      // pre-status placeholder.
      await expect(chipOf(rows.stale), `stale chip never settled (${t})`).toHaveText("3h", {
        timeout: T_LONG * 2,
      });
      await expect(chipOf(rows.anon)).toHaveText("2d", { timeout: T_LONG * 2 });
      await expect(chipOf(rows.old)).toHaveText(/\d{4}/, { timeout: T_LONG * 2 });
      await refreshFresh(page, repo.freshFile);
      await parkPointer(page);

      await step("rest", async () => {
        await snap(page, `${t}-10-sidebar-rest`, page.locator(SEL.sidebar.aside).first());
        await snap(page, `${t}-11-row-fresh`, detailsRowOf(rows.fresh), /now|\d+s/);
        await snap(page, `${t}-12-row-stale`, detailsRowOf(rows.stale), "3h");
        await snap(page, `${t}-13-row-old`, detailsRowOf(rows.old), /\d{4}/);
        await snap(page, `${t}-14-row-anon`, detailsRowOf(rows.anon), "2d");
      });

      await step("hover", async () => {
        await refreshFresh(page, repo.freshFile);
        let card = await hoverChip(page, rows.fresh, "Avery Lindqvist");
        await snapRegion(page, `${t}-20-hover-fresh`, [detailsRowOf(rows.fresh), card]);
        card = await hoverChip(page, rows.stale, "Claude");
        await snapRegion(page, `${t}-21-hover-stale-agent`, [detailsRowOf(rows.stale), card]);
        card = await hoverChip(page, rows.old, "Priya");
        await snapRegion(page, `${t}-22-hover-old-long`, [detailsRowOf(rows.old), card]);
        card = await hoverChip(page, rows.anon, "Last commit");
        await snapRegion(page, `${t}-23-hover-no-author`, [detailsRowOf(rows.anon), card]);
        await parkPointer(page);
      });

      // Real Tab presses: a scripted .focus() does not satisfy :focus-visible,
      // so the shot would show no focus styling and lie about the state.
      await step("focus", async () => {
        await parkPointer(page);
        const chip = chipOf(rows.stale);
        // Park the chip on screen first so the focus does not scroll the list;
        // the below-the-fold case is its own step.
        await chip.evaluate((el) => el.scrollIntoView({ block: "center" }));
        await tabTo(page, chip);
        const card = openHoverCard(page);
        await expect(card, "focus did not open the hover card").toBeVisible({ timeout: T_LONG });
        await snapRegion(page, `${t}-30-focus-stale`, [detailsRowOf(rows.stale), card]);
        await snap(page, `${t}-31-focus-row-stale`, detailsRowOf(rows.stale), "3h");
        await page.keyboard.press("Escape");
        await settle(page, 300);
        const stillOpen = await openHoverCard(page)
          .isVisible()
          .catch(() => false);
        if (stillOpen) throw new Error("Escape did not dismiss the hover card (WCAG 1.4.13)");
        await snap(page, `${t}-32-focus-after-escape`, detailsRowOf(rows.stale), "3h");
        await page.locator(SEL.worktree.searchInput).first().click();
        await parkPointer(page);
      });

      // Tabbing to a chip that is below the fold scrolls the list to reveal it.
      // The shot is named after what the hover card actually did, so it can
      // never pass off one outcome as the other.
      await step("focus-fold", async () => {
        await parkPointer(page);
        const chip = chipOf(rows.stale);
        await chip.evaluate((el) => {
          for (let n = el.parentElement; n; n = n.parentElement) {
            if (
              n.scrollHeight > n.clientHeight + 4 &&
              getComputedStyle(n).overflowY !== "visible"
            ) {
              n.scrollTop = 0;
            }
          }
        });
        await settle(page, 300);
        const scrolledBefore = await chip.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.bottom > window.innerHeight - 200;
        });
        await tabTo(page, chip);
        await settle(page, 600);
        const open = await openHoverCard(page)
          .isVisible()
          .catch(() => false);
        const outcome = `${scrolledBefore ? "below-fold" : "in-view"}-${open ? "open" : "closed"}`;
        const targets = [detailsRowOf(rows.stale)];
        if (open) targets.push(openHoverCard(page));
        await snapRegion(page, `${t}-33-focus-${outcome}`, targets);
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
  console.log(`[chip-shots] wrote ${written.size} shots; ${onDisk.length} PNGs on disk`);
  if (written.size === 0) throw new Error("[chip-shots] produced no screenshots at all");
  if (stepFailures.length > 0) {
    throw new Error(
      `[chip-shots] ${stepFailures.length} step(s) failed:\n${stepFailures.join("\n")}`
    );
  }
});
