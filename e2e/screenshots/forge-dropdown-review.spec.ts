/**
 * Issue / PR dropdown visual-review harness.
 *
 * Boots a fixture repo with a GitHub remote, seeds a fake token, stubs the
 * forge list handlers with rich fixtures (labels, assignees, comments, linked
 * PRs, CI status, drafts), then writes PNGs of the issues and pull-requests
 * dropdowns so design work on them can be judged against real rendered pixels.
 *
 * Opt-in only — skips itself unless DAINTREE_SHOT_FORGE is set, so the
 * marketing screenshots workflow never runs it.
 *
 *   DAINTREE_SHOT_FORGE=1 npx playwright test --project=screenshots forge-dropdown-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_FORGE   required — any truthy value
 *   DAINTREE_SHOT_TAG     optional suffix to keep rounds side by side
 *   DAINTREE_SHOT_THEME   optional theme id (default: the app default)
 *   DAINTREE_SHOT_ONLY    comma-separated step filter
 *
 * Output: artifacts/forge-shots/<NN-slug>[-tag].png (gitignored).
 */

import { test, type Page, type Locator, type ElectronApplication } from "@playwright/test";
import { mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { connectGitHub, stubRepoStats } from "../helpers/githubHelpers";
import { SEL } from "../helpers/selectors";
import { T_MEDIUM } from "../helpers/timeouts";
import type { Issue, PR } from "../../shared/types/forge";

const ENABLED = Boolean(process.env.DAINTREE_SHOT_FORGE);
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
/** Comma-separated theme ids to sweep in one session (overrides DAINTREE_SHOT_THEME). */
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "").split(",").filter(Boolean);
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = path.resolve(process.cwd(), "artifacts", "forge-shots");

const POLISH_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

const MIN = 60_000;
const AVATAR =
  "data:image/svg+xml;base64," +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#4a6b8a"/><circle cx="16" cy="12" r="6" fill="#c8d8e4"/><ellipse cx="16" cy="28" rx="11" ry="9" fill="#c8d8e4"/></svg>`
  ).toString("base64");

function issue(n: number, title: string, over: Partial<Issue> = {}): Issue {
  const updatedAt = Date.now() - n * MIN;
  return {
    number: n,
    title,
    body: "",
    state: "open",
    rawState: "OPEN",
    url: `https://github.com/daintreehq/daintree/issues/${n}`,
    author: { login: "gregpriday", avatarUrl: AVATAR },
    assignees: [],
    labels: [],
    commentCount: 0,
    createdAt: updatedAt,
    updatedAt,
    rawData: {},
    ...over,
  };
}

function pr(n: number, title: string, over: Partial<PR> = {}): PR {
  const updatedAt = Date.now() - n * MIN;
  return {
    number: n,
    title,
    body: "",
    state: "open",
    rawState: "OPEN",
    isDraft: false,
    merged: false,
    url: `https://github.com/daintreehq/daintree/pull/${n}`,
    author: { login: "gregpriday", avatarUrl: AVATAR },
    baseRef: "develop",
    headRef: `feature/issue-${n}`,
    commentCount: 0,
    createdAt: updatedAt,
    updatedAt,
    rawData: {},
    ...over,
  };
}

const L = (name: string, color: string) => ({ name, color });

const ISSUES: Issue[] = [
  issue(11958, "Restart into a scratch workspace restores an unnamed project shell", {
    labels: [L("bug", "d73a4a"), L("backend", "e99695")],
  }),
  issue(11957, "Cmd+Alt+I falls back to the fleet view in most projects", {
    labels: [L("bug", "d73a4a"), L("ui", "fbe1d5")],
    commentCount: 3,
  }),
  issue(11949, "Show Claude Code subagents as inspectable child terminals", {
    labels: [L("enhancement", "a2eeef"), L("terminal", "5319e7")],
    assignees: [{ login: "gregpriday", avatarUrl: AVATAR }],
  }),
  issue(11755, "Publish Daintree to winget", {
    labels: [L("enhancement", "a2eeef"), L("infrastructure", "0e8a16")],
  }),
  issue(11745, "Bundle the assistant CLI into release builds", {
    labels: [L("infrastructure", "0e8a16"), L("future-work", "5aa9e6")],
    commentCount: 1,
  }),
  issue(11244, "Fold the forge slot view seam into the panel contract", {
    labels: [L("architecture", "c5def5"), L("plugins", "7cd44a")],
    commentCount: 1,
    assignees: [{ login: "gregpriday", avatarUrl: AVATAR }],
    linkedPR: {
      number: 11250,
      state: "open",
      url: "https://github.com/daintreehq/daintree/pull/11250",
    },
  }),
  issue(11210, "Renderer memory climbs to 3.2GB across a long session", {
    labels: [L("bug", "d73a4a"), L("performance", "fbca04")],
    commentCount: 12,
  }),
  issue(11158, "Remote SSH workspace mode", {
    labels: [L("epic", "3e4b9e")],
    assignees: [{ login: "gregpriday", avatarUrl: AVATAR }],
  }),
];

const PRS: PR[] = [
  pr(11956, "fix(compiler-budget): close the regeneration wedges", {
    ciStatus: "success",
    commentCount: 2,
  }),
  pr(11955, "feature(pilot): group a project's agents", { ciStatus: "pending" }),
  pr(11950, "refactor(panels): fold the forge slot view seam", {
    isDraft: true,
    ciStatus: "failure",
    commentCount: 5,
  }),
  pr(11940, "perf(renderer): shard the worktree port broker", { ciStatus: "success" }),
  pr(11930, "chore(deps): hold vite at 8.0.14", { ciStatus: "success", commentCount: 1 }),
  pr(11920, "feat(brand): rework the brand-mark ink model", { ciStatus: "success" }),
  pr(11910, "fix(terminal): guard the poisoned xterm open() wedge", { ciStatus: "failure" }),
];

async function stubList(
  app: ElectronApplication,
  channel: string,
  items: unknown[]
): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, { channel, response }) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async () => response);
    },
    { channel, response: { items, nextCursor: null, hasMore: false, totalCount: items.length } }
  );
}

async function settle(page: Page, ms = 600): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function snap(page: Page, slug: string, locator?: Locator): Promise<void> {
  await settle(page);
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  if (locator) {
    await locator.first().screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }
}

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
/* A step failure must not abort the remaining captures, but it must not pass
   silently either — a run where every step blew up would otherwise report PASS
   and write no PNGs. Failures are collected and rethrown at the end. */
const stepFailures: string[] = [];
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    stepFailures.push(`${name}: ${String(error).slice(0, 300)}`);
    console.warn(`[forge-shots] step "${name}" skipped:`, String(error).slice(0, 300));
  }
}

/** The dropdown panel itself — the fixed-dropdown surface that holds the list. */
function panel(page: Page, listSel: string): Locator {
  return page
    .locator(listSel)
    .locator('xpath=ancestor::div[contains(@class,"surface-overlay")][1]');
}

test("forge dropdown review — issues and pull requests", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_FORGE is required for the forge dropdown capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_FORGE to run the forge dropdown capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo({ name: "forge-shots", withGitHubRemote: true });
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-forgeshot-"));
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      env: { DAINTREE_E2E_FAULT_MODE: "1" },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Daintree");
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);

    await stubList(ctx.app, "forge:list-issues", process.env.DAINTREE_SHOT_EMPTY ? [] : ISSUES);
    await stubList(ctx.app, "forge:list-prs", PRS);
    await connectGitHub(ctx.app, page);
    await stubRepoStats(
      ctx.app,
      { issueCount: ISSUES.length, prCount: PRS.length, commitCount: 4 },
      page
    );
    await settle(page, 1500);
    await dismissBlockingPalette(page);

    await step("issues", async () => {
      const pill = page.locator(SEL.github.statPillIssues);
      await pill.waitFor({ state: "visible", timeout: T_MEDIUM });
      await pill.click();
      await page.locator(SEL.github.listIssues).waitFor({ state: "visible", timeout: T_MEDIUM });
      await settle(page, 1200);
      await snap(
        page,
        process.env.DAINTREE_SHOT_EMPTY ? "26-issues-empty" : "20-issues-dropdown",
        panel(page, SEL.github.listIssues)
      );
      await snap(page, "21-issues-in-context");
    });

    await step("issues-hover", async () => {
      await page.locator(SEL.github.item(11957)).hover();
      await settle(page, 400);
      await snap(page, "22-issues-row-hover", panel(page, SEL.github.listIssues));
      await page.keyboard.press("Escape");
      await settle(page, 400);
    });

    await step("prs", async () => {
      await page.keyboard.press("Escape").catch(() => {});
      const pill = page.locator(SEL.github.statPillPrs);
      await pill.waitFor({ state: "visible", timeout: T_MEDIUM });
      await pill.click();
      await page.locator(SEL.github.listPrs).waitFor({ state: "visible", timeout: T_MEDIUM });
      await settle(page, 1200);
      await snap(page, "30-prs-dropdown", panel(page, SEL.github.listPrs));
      await page.keyboard.press("Escape");
      await settle(page, 400);
    });

    await step("selection", async () => {
      await page.locator(SEL.github.statPillIssues).click();
      await page.locator(SEL.github.listIssues).waitFor({ state: "visible", timeout: T_MEDIUM });
      await settle(page, 800);
      // Keyboard route: the cursor lands on a row, Shift+Space takes it into
      // the selection (bare Space stays a search character).
      await page.keyboard.press("ArrowDown");
      await settle(page, 200);
      await page.keyboard.press("Shift+Space");
      await settle(page, 300);
      await page.keyboard.press("ArrowDown");
      await settle(page, 200);
      await page.keyboard.press("Shift+Space");
      await settle(page, 500);
      await snap(page, "25-issues-selection", panel(page, SEL.github.listIssues));
      await page.keyboard.press("Escape");
      await settle(page, 300);
      await page.keyboard.press("Escape");
      await settle(page, 400);
    });

    // Empty/loading states are captured by a separate opt-in run
    // (DAINTREE_SHOT_EMPTY=1) that seeds an empty list before the first fetch.
    // Swapping the live IPC handler mid-session crashes the project view — a
    // harness limitation, reproducible on unmodified code.

    // Cross-theme sweep: one shot of each dropdown per theme, same session.
    await step("themes", async () => {
      for (const themeId of THEMES) {
        await setAppTheme(page, themeId);
        await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
        await settle(page, 800);
        await page.locator(SEL.github.statPillIssues).click();
        await page.locator(SEL.github.listIssues).waitFor({ state: "visible", timeout: T_MEDIUM });
        await settle(page, 900);
        await snap(page, `40-theme-${themeId}-issues`, panel(page, SEL.github.listIssues));
        await page.keyboard.press("Escape");
        await settle(page, 400);
        await page.locator(SEL.github.statPillPrs).click();
        await page.locator(SEL.github.listPrs).waitFor({ state: "visible", timeout: T_MEDIUM });
        await settle(page, 900);
        await snap(page, `41-theme-${themeId}-prs`, panel(page, SEL.github.listPrs));
        await page.keyboard.press("Escape");
        await settle(page, 400);
      }
    });
  } finally {
    if (ctx) await closeApp(ctx);
    repo.cleanup();
  }

  if (stepFailures.length > 0) {
    throw new Error(
      `[forge-shots] ${stepFailures.length} step(s) failed:\n${stepFailures.join("\n")}`
    );
  }
});
