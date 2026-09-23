/**
 * Worktree-delete dialog visual-review harness, part two: the gates.
 *
 * `worktree-delete-dialog-review` covers the states the dialog had when it was
 * first reviewed (clean, dirty, terminals, a failed status fetch). Everything
 * the delete gate learned afterwards lives here instead, because it needs a
 * different fixture: a repository with a real submodule, so the inventory the
 * dialog runs on open has real nested work to find. Nothing is mocked — each
 * state is a genuine git state the host's own inventory reports on.
 *
 *   - unpushed submodule commits → the refusal (no consent unblocks it)
 *   - more commits than the rev walk will count → the "at least" refusal
 *   - an inventory that cannot finish → the other refusal
 *   - dirty submodule files → force required, and the typed-name gate
 *   - parent changes plus nested changes → both lists at once
 *   - a worktree on a protected branch → the typed-name gate on a clean tree
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_DELETE is set.
 *
 *   DAINTREE_SHOT_DELETE=1 npx playwright test --project=screenshots worktree-delete-dialog-gates-review
 *
 * Takes the same knobs as the first harness (DAINTREE_SHOT_THEME, _TAG, _ONLY,
 * _OUT). Themes still boot one per run — switching in place crashes the view.
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

const ENABLED = !!process.env.DAINTREE_SHOT_DELETE;
const PANEL = `${SEL.worktree.deleteDialog} > div`;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR =
  process.env.DAINTREE_SHOT_OUT ?? path.resolve(process.cwd(), "artifacts", "delete-dialog-shots");

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

const SUBMODULE_PATH = "vendor/codec";
const WT_SUB_COMMITS = "feature/codec-simd-decoder";
const WT_SUB_CAPPED = "feature/codec-rewrite";
const WT_SUB_DIRTY = "fix/codec-endianness";
const WT_SUB_UNVERIFIED = "chore/codec-audit";
const WT_MIXED = "fix/decoder-overflow";
const WT_PROTECTED = "main";

function git(cmd: string, cwd: string): void {
  execSync(`git -c protocol.file.allow=always ${cmd}`, { cwd, stdio: "ignore" });
}

function wtDir(wtRoot: string, branch: string): string {
  return path.join(wtRoot, branch.replace(/\//g, "-"));
}

function commitInSubmodule(checkout: string, count: number, subjects: string[]): void {
  git('config user.email "test@daintree.dev"', checkout);
  git('config user.name "Daintree Test"', checkout);
  for (let i = 0; i < count; i++) {
    writeFileSync(path.join(checkout, `simd-${i}.c`), `int simd_${i}(void) { return ${i}; }\n`);
    git("add -A", checkout);
    const subject = subjects[i] ?? `Unroll decode loop, pass ${i + 1}`;
    git(`commit -m ${JSON.stringify(subject)}`, checkout);
  }
}

/**
 * A parent repository whose develop branch records one submodule, and a
 * worktree per gate state. Each worktree initialises its own copy of the
 * submodule (module store under `.git/worktrees/<name>/modules`), which is what
 * the host's inventory walks at delete time.
 */
function createFixtureRepo(): {
  dir: string;
  wtRoot: string;
  cleanup: () => void;
} {
  const base = mkdtempSync(path.join(tmpdir(), "daintree-delete-gates-"));
  const upstream = path.join(base, "codec-upstream");
  const dir = path.join(base, "helios");
  const wtRoot = path.join(base, "helios-worktrees");
  mkdirSync(upstream, { recursive: true });
  mkdirSync(dir, { recursive: true });
  mkdirSync(wtRoot, { recursive: true });

  git("init -b main", upstream);
  git('config user.email "test@daintree.dev"', upstream);
  git('config user.name "Daintree Test"', upstream);
  writeFileSync(path.join(upstream, "decode.c"), "int decode(void) { return 0; }\n");
  writeFileSync(path.join(upstream, "encode.c"), "int encode(void) { return 0; }\n");
  git("add -A", upstream);
  git('commit -m "codec: initial import"', upstream);

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(path.join(dir, "src", "index.ts"), "export const main = (): number => 0;\n");
  writeFileSync(path.join(dir, "src", "decoder.ts"), "export const frames: number[] = [];\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  git("branch develop", dir);
  git("checkout develop", dir);
  git(`submodule add ${JSON.stringify(upstream)} ${SUBMODULE_PATH}`, dir);
  git('commit -m "vendor the codec"', dir);
  // `main` predates the submodule on purpose: the protected-branch worktree is
  // a clean tree with no nested work, so the only thing gating it is the name.
  for (const branch of [WT_SUB_COMMITS, WT_SUB_CAPPED, WT_SUB_DIRTY, WT_SUB_UNVERIFIED, WT_MIXED]) {
    git(`branch ${branch}`, dir);
  }
  for (const branch of [
    WT_SUB_COMMITS,
    WT_SUB_CAPPED,
    WT_SUB_DIRTY,
    WT_SUB_UNVERIFIED,
    WT_MIXED,
    WT_PROTECTED,
  ]) {
    const wt = wtDir(wtRoot, branch);
    git(`worktree add ${JSON.stringify(wt)} ${branch}`, dir);
    if (branch !== WT_PROTECTED) git("submodule update --init", wt);
  }

  // Two commits no remote has seen — the refusal the host throws before it
  // ever reads `force`.
  const commitsCheckout = path.join(wtDir(wtRoot, WT_SUB_COMMITS), SUBMODULE_PATH);
  git("checkout -b simd", commitsCheckout);
  commitInSubmodule(commitsCheckout, 2, [
    "Add AVX2 path for the frame decoder",
    "Fall back to scalar decode when the CPU lacks SSE4.1",
  ]);

  // More than the rev walk's ceiling (50), so the host reports a floor, not a
  // total — the "at least" wording, and the collapsed list tail.
  const cappedCheckout = path.join(wtDir(wtRoot, WT_SUB_CAPPED), SUBMODULE_PATH);
  git("checkout -b rewrite", cappedCheckout);
  commitInSubmodule(cappedCheckout, 53, []);

  // Nested working-tree content: the one submodule state force consents to.
  const dirtyCheckout = path.join(wtDir(wtRoot, WT_SUB_DIRTY), SUBMODULE_PATH);
  writeFileSync(path.join(dirtyCheckout, "decode.c"), "int decode(void) { return 1; }\n");
  writeFileSync(path.join(dirtyCheckout, "encode.c"), "int encode(void) { return 1; }\n");
  writeFileSync(path.join(dirtyCheckout, "endian.h"), "#define LE 1\n");

  // A module store holding nested modules is outside what the inventory
  // models, so it cannot finish — the refusal with no commits to name.
  const unverifiedGitDir = execSync("git rev-parse --absolute-git-dir", {
    cwd: wtDir(wtRoot, WT_SUB_UNVERIFIED),
  })
    .toString()
    .trim();
  mkdirSync(path.join(unverifiedGitDir, "modules", SUBMODULE_PATH, "modules", "nested"), {
    recursive: true,
  });

  // Parent changes and nested changes together — the two lists stacked.
  const mixed = wtDir(wtRoot, WT_MIXED);
  writeFileSync(path.join(mixed, "src", "decoder.ts"), "export const frames: Uint8Array[] = [];\n");
  writeFileSync(path.join(mixed, "src", "overflow.ts"), "export const MAX_FRAME = 1 << 20;\n");
  writeFileSync(path.join(mixed, SUBMODULE_PATH, "decode.c"), "int decode(void) { return 2; }\n");

  return {
    dir,
    wtRoot,
    cleanup: () => {
      if (existsSync(base)) rmSync(base, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 500): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

const written: string[] = [];

async function snap(page: Page, slug: string, locator?: string): Promise<void> {
  await settle(page);
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  if (locator) {
    await page.locator(locator).first().screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }
  written.push(path.basename(file));
}

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
let activePage: Page | undefined;
const failed: string[] = [];

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    failed.push(name);
    console.warn(`[delete-gates] step "${name}" FAILED:`, String(error).slice(0, 400));
    if (activePage) {
      for (let i = 0; i < 3; i++) {
        await activePage.keyboard.press("Escape").catch(() => {});
        await activePage.waitForTimeout(200);
      }
    }
  }
}

async function openActionsMenu(page: Page, branch: string): Promise<void> {
  if (
    await page
      .locator('[role="menu"]')
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await page.keyboard.press("Escape");
    await settle(page, 250);
  }
  const card = page.locator(SEL.worktree.card(branch)).first();
  await card.scrollIntoViewIfNeeded().catch(() => {});
  await card.hover().catch(() => {});
  await card.locator(SEL.worktree.actionsMenu).first().click();
  await page.locator('[role="menu"]').first().waitFor({ state: "visible", timeout: 5000 });
  await settle(page, 300);
}

/**
 * Open the dialog and wait for the preview to settle on the evidence the shot
 * is about. The inventory runs over a MessagePort after open, so a fixed sleep
 * would capture the pending state and call it the gate.
 */
async function openDialog(page: Page, branch: string, settledOn: string): Promise<void> {
  await openActionsMenu(page, branch);
  const deleteItem = page.getByRole("menuitem", { name: /delete worktree/i }).first();
  await deleteItem.hover();
  await deleteItem.click();
  const dialog = page.locator(SEL.worktree.deleteDialog);
  await dialog.waitFor({ state: "visible", timeout: 8000 });
  await dialog.locator(settledOn).first().waitFor({ state: "visible", timeout: 20000 });
  await settle(page, 1000);
}

async function closeDialog(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 200);
  }
}

async function toggle(page: Page, labelText: string): Promise<void> {
  await page
    .locator(`${SEL.worktree.deleteDialog} label`, { hasText: labelText })
    .first()
    .locator('input[type="checkbox"]')
    .click();
  await settle(page, 400);
}

const BLOCKED = '[data-testid="delete-worktree-blocked"]';
const SUBMODULES = '[data-testid="delete-worktree-submodules"]';
const OPTIONS = "fieldset";

test("worktree-delete dialog review — submodule and typed-name gates", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_DELETE is required for the delete-dialog capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_DELETE to run the delete-dialog capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-deletegates-"));
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    activePage = page;
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await page
      .locator(SEL.worktree.mainCard)
      .waitFor({ state: "visible", timeout: T_LONG })
      .catch(() => {});
    await settle(page, 4000);
    await dismissBlockingPalette(page);

    // Refusal: unpushed submodule commits. No option unblocks it, so the
    // shot is about whether the dialog stops offering a delete.
    await step("sub-commits", async () => {
      await openDialog(page, WT_SUB_COMMITS, BLOCKED);
      await snap(page, "100-sub-commits-blocked", PANEL);
      await snap(page, "101-sub-commits-blocked-in-window");
      await closeDialog(page);
    });

    // Refusal with a capped walk: the count is a floor.
    await step("sub-capped", async () => {
      await openDialog(page, WT_SUB_CAPPED, BLOCKED);
      await snap(page, "105-sub-commits-capped", PANEL);
      await closeDialog(page);
    });

    // Refusal: the inventory could not finish.
    await step("sub-unverified", async () => {
      await openDialog(page, WT_SUB_UNVERIFIED, BLOCKED);
      await page
        .locator(BLOCKED)
        .getByText(/Couldn't finish checking/i)
        .waitFor({ state: "visible", timeout: 5000 });
      await snap(page, "110-sub-unverified-blocked", PANEL);
      await closeDialog(page);
    });

    // Nested files, force off: the standard delete is unavailable.
    await step("sub-dirty", async () => {
      await openDialog(page, WT_SUB_DIRTY, SUBMODULES);
      await snap(page, "120-sub-dirty-force-off", PANEL);
      await closeDialog(page);
    });

    // Nested files, force on: D3 on submodule content alone.
    await step("sub-dirty-force", async () => {
      await openDialog(page, WT_SUB_DIRTY, SUBMODULES);
      await toggle(page, "Force delete");
      await page.locator(SEL.worktree.deleteConfirmInput).waitFor({ state: "visible" });
      await snap(page, "125-sub-dirty-force-on", PANEL);
      await closeDialog(page);
    });

    // Parent changes and nested changes, force on: the tallest gate state.
    await step("mixed", async () => {
      await openDialog(page, WT_MIXED, SUBMODULES);
      await toggle(page, "Force delete");
      await page.locator(SEL.worktree.deleteConfirmInput).waitFor({ state: "visible" });
      await snap(page, "130-mixed-force-on", PANEL);
      await snap(page, "131-mixed-force-on-in-window");
      await closeDialog(page);
    });

    // Protected branch, clean tree, force on: the gate is up for the name
    // alone, so the preamble is the only thing explaining why.
    await step("protected", async () => {
      await openDialog(page, WT_PROTECTED, OPTIONS);
      await snap(page, "140-protected-force-off", PANEL);
      await toggle(page, "Force delete");
      await page.locator(SEL.worktree.deleteConfirmInput).waitFor({ state: "visible" });
      await snap(page, "145-protected-force-on", PANEL);
      await page.locator(SEL.worktree.deleteConfirmInput).fill("mai");
      await snap(page, "146-protected-partial-name", PANEL);
      await closeDialog(page);
    });
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  const onDisk = readdirSync(OUTPUT_DIR).filter((f) => written.includes(f));
  console.log(`[delete-gates] wrote ${written.length} shots to ${OUTPUT_DIR}`);
  expect(failed, `steps failed: ${failed.join(", ")}`).toEqual([]);
  expect(written.length, "capture produced no screenshots").toBeGreaterThan(0);
  expect(onDisk.length, "screenshots were not written to disk").toBe(written.length);
});
