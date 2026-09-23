/**
 * `UpstreamSyncBadge` visual-review harness — the ahead/behind line on each
 * worktree card's secondary row.
 *
 * Every state comes from real git against a real bare remote, so a capture is
 * a state the app can actually produce:
 *   - upstream ahead / behind: local commits past the pushed tip, and commits
 *     pushed to the branch from a second clone then fetched
 *   - base divergence: the integration branch advanced on the remote
 *   - resting (`≡ develop`) and no upstream (`· local`): pushed-and-idle and
 *     never-pushed branches
 *   - main worktree: unpushed local commits on `develop` itself
 *   - auth failed, network failed, stale, and fetch in flight: real git cannot
 *     produce these in a capture run (see the "patched" step), so they go
 *     through the worktree MessagePort the renderer already listens on, with
 *     real snapshots patched
 *
 * Opt-in: skips itself unless DAINTREE_SHOT_SYNC is set.
 *
 *   DAINTREE_SHOT_SYNC=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     npx playwright test --project=screenshots upstream-sync-badge-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SYNC     required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR     output dir (default artifacts/sync-badge-shots, gitignored)
 *   DAINTREE_SHOT_ONLY     comma-separated step filter
 *   DAINTREE_SHOT_THEMES   comma-separated theme sweep (default: a light/dark spread)
 *
 * Like the other review harnesses, nothing is written that has not been
 * verified: `snap()` asserts the target is visible, has a real box and carries
 * the state's own content before it writes, and throws otherwise.
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

const ENABLED = !!process.env.DAINTREE_SHOT_SYNC;
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : path.resolve(process.cwd(), "artifacts", "sync-badge-shots");

/** A spread across light and dark, including the two darkest palettes where text-muted has no floor. */
const DEFAULT_THEMES = ["daintree", "namib", "redwoods", "bondi", "svalbard", "hokkaido"];
const SWEEP_THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

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

const BASE = "develop";

/** Card branches, each shaped to produce one badge state. */
const B = {
  resting: "feature/sync-resting",
  ahead: "feature/sync-ahead",
  behind: "feature/sync-behind",
  both: "feature/sync-diverged",
  baseBehind: "feature/sync-base-behind",
  local: "feature/sync-local-only",
  localResting: "feature/sync-local-resting",
} as const;

const SLUG: Record<string, string> = {
  [B.resting]: "resting",
  [B.ahead]: "ahead",
  [B.behind]: "behind",
  [B.both]: "diverged",
  [B.baseBehind]: "base-behind",
  [B.local]: "local-only",
  [B.localResting]: "local-resting",
};

type Snapshot = { branch?: string } & Record<string, unknown>;

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString();
}

function commit(dir: string, file: string, body: string, msg: string): void {
  writeFileSync(path.join(dir, file), body);
  git(`add -A`, dir);
  git(`commit -q -m "${msg}"`, dir);
}

function commits(dir: string, prefix: string, n: number): void {
  for (let i = 1; i <= n; i++)
    commit(dir, `${prefix}-${i}.txt`, `${prefix} ${i}\n`, `${prefix} ${i}`);
}

interface Fixture {
  dir: string;
  remote: string;
  cleanup: () => void;
}

function createFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "daintree-syncshots-"));
  const dir = path.join(root, "helios");
  const remote = path.join(root, "remote.git");
  const clone = path.join(root, "teammate");
  const wtRoot = path.join(root, "helios-worktrees");
  mkdirSync(dir);
  mkdirSync(wtRoot);

  const ident = (d: string) => {
    git('config user.email "avery@helios.dev"', d);
    git('config user.name "Avery Lindqvist"', d);
  };

  git(`init -q --bare -b ${BASE} "${remote}"`, root);
  git(`init -q -b ${BASE}`, dir);
  ident(dir);
  writeFileSync(path.join(dir, "README.md"), "# Helios\n");
  git("add -A", dir);
  git('commit -q -m "Initial commit"', dir);
  git(`remote add origin "${remote}"`, dir);
  git(`push -q -u origin ${BASE}`, dir);
  const v0 = git("rev-parse HEAD", dir).trim();

  // A teammate advances develop on the remote by seven commits.
  git(`clone -q "${remote}" "${clone}"`, root);
  ident(clone);
  commits(clone, "develop-work", 7);
  git(`push -q origin ${BASE}`, clone);
  git("fetch -q origin", dir);

  const add = (branch: string, from: string) => {
    const wt = path.join(wtRoot, SLUG[branch]);
    git(`worktree add -q --no-track -b ${branch} "${wt}" ${from}`, dir);
    ident(wt);
    return wt;
  };
  const pushU = (wt: string, branch: string) => git(`push -q -u origin ${branch}`, wt);

  // ≡ develop: pushed, on the base tip, nothing to say but the relationship.
  const resting = add(B.resting, `origin/${BASE}`);
  pushU(resting, B.resting);

  // ↑2 upstream, Δ develop ↑3.
  const ahead = add(B.ahead, `origin/${BASE}`);
  commits(ahead, "ahead", 1);
  pushU(ahead, B.ahead);
  commits(ahead, "ahead-local", 2);

  // ↓4 upstream (teammate pushed to the branch), Δ develop ↑1.
  const behind = add(B.behind, `origin/${BASE}`);
  commits(behind, "behind", 1);
  pushU(behind, B.behind);
  git("fetch -q origin", clone);
  git(`checkout -q -b ${B.behind} origin/${B.behind}`, clone);
  commits(clone, "teammate", 4);
  git(`push -q origin ${B.behind}`, clone);
  git("fetch -q origin", behind);

  // ↑1 ↓3 upstream (a rewritten local tip), and drift on both sides of develop.
  const both = add(B.both, `origin/${BASE}`);
  commits(both, "diverged", 2);
  pushU(both, B.both);
  git("fetch -q origin", clone);
  git(`checkout -q -b ${B.both} origin/${B.both}`, clone);
  commits(clone, "teammate-diverged", 2);
  git(`push -q origin ${B.both}`, clone);
  git("fetch -q origin", both);
  git(`reset -q --hard HEAD~1`, both);
  commits(both, "diverged-local", 1);

  // Δ develop ↑2 ↓7: branched before the teammate's seven, pushed.
  const baseBehind = add(B.baseBehind, v0);
  commits(baseBehind, "base-behind", 2);
  pushU(baseBehind, B.baseBehind);

  // Δ develop ↑1 · local: never pushed.
  const local = add(B.local, `origin/${BASE}`);
  commits(local, "local", 1);

  // ≡ develop · local: just created, never pushed.
  add(B.localResting, `origin/${BASE}`);

  // Main worktree: two unpushed commits on develop, and seven behind origin.
  commits(dir, "hotfix", 2);

  return {
    dir,
    remote,
    cleanup: () => {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
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
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const stepFailures: string[] = [];

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).slice(0, 500);
    stepFailures.push(`${name}: ${detail}`);
    console.warn(`[sync-shots] step "${name}" FAILED:`, detail);
  }
}

async function snap(
  page: Page,
  slug: string,
  target: Locator,
  expectText?: string | RegExp,
  // "disabled" finishes a paused animation before the shot, which is right for
  // every state but the one whose content IS a frozen animation frame.
  animations: "disabled" | "allow" = "disabled"
): Promise<void> {
  await settle(page);
  await expect(target, `"${slug}": target never became visible — refusing to write`).toBeVisible({
    timeout: T_LONG,
  });
  const box = await target.boundingBox();
  if (!box || box.width < 40 || box.height < 16) {
    throw new Error(`"${slug}": target box is ${JSON.stringify(box)} — refusing to write`);
  }
  if (expectText !== undefined) {
    await expect(target, `"${slug}": expected content missing — refusing to write`).toContainText(
      expectText,
      { timeout: T_LONG }
    );
  }
  await target.screenshot({
    path: path.join(OUTPUT_DIR, `${slug}.png`),
    type: "png",
    animations,
    caret: "hide",
  });
  written.add(`${slug}.png`);
}

/** Shoot a region that spans the badge and its open tooltip. */
async function snapTooltip(
  page: Page,
  slug: string,
  badge: Locator,
  expectText: string | RegExp
): Promise<void> {
  await page.mouse.move(1600, 1000);
  await settle(page, 200);
  await badge.hover();
  const tip = page.locator('[role="tooltip"]').first();
  const content = page.locator("[data-radix-popper-content-wrapper]").last();
  await expect(tip, `"${slug}": tooltip never opened`).toBeAttached({ timeout: T_LONG });
  await expect(content, `"${slug}": tooltip content missing`).toContainText(expectText, {
    timeout: T_LONG,
  });
  await settle(page, 300);
  const a = await badge.boundingBox();
  const b = await content.boundingBox();
  if (!a || !b) throw new Error(`"${slug}": badge or tooltip has no box`);
  const pad = 12;
  const x = Math.max(0, Math.min(a.x, b.x) - pad);
  const y = Math.max(0, Math.min(a.y, b.y) - pad);
  const w = Math.max(a.x + a.width, b.x + b.width) + pad - x;
  const h = Math.max(a.y + a.height, b.y + b.height) + pad - y;
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${slug}.png`),
    type: "png",
    clip: { x, y, width: w, height: h },
    animations: "disabled",
    caret: "hide",
  });
  written.add(`${slug}.png`);
  await page.mouse.move(1600, 1000);
  await settle(page, 200);
}

const row = (page: Page, branch: string): Locator => page.locator(SEL.worktree.row(branch)).first();
const mainRow = (page: Page): Locator =>
  page.locator('[data-worktree-row]:has([data-worktree-is-main="true"])').first();
const badgeIn = (r: Locator): Locator =>
  r.locator('[data-testid="upstream-sync-indicator"]').first();
/** The card's secondary block — branch, PR, sync line — plus a little of the headline for context. */
const cardOf = (r: Locator): Locator => r.locator(".sidebar-worktree-card").first();

test("upstream sync badge review — states and themes", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SYNC is required for the sync-badge capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_SYNC to run the sync-badge capture");
  test.setTimeout(15 * 60_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const fx = createFixture();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-syncshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      env: { GIT_TERMINAL_PROMPT: "0", DAINTREE_E2E_FAULT_MODE: "1" },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, fx.dir, "Helios");
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);

    const sidebar = page.locator(SEL.sidebar.aside).first();
    for (const branch of Object.values(B)) {
      await expect(row(page, branch), `card ${branch} never rendered`).toBeVisible({
        timeout: T_LONG,
      });
    }
    // Counts arrive on the status pass; wait for the one that proves the
    // teammate's fetched commits are in.
    await expect(badgeIn(row(page, B.behind)), "behind counts never arrived").toContainText("↓4", {
      timeout: T_LONG * 2,
    });
    await expect(badgeIn(row(page, B.baseBehind))).toContainText("↓7", { timeout: T_LONG * 2 });
    await settle(page, 1200);
    await dismissBlockingPalette(page);
    await page.mouse.move(1600, 1000);

    await step("sidebar", async () => {
      await snap(page, "10-sidebar", sidebar);
    });

    await step("cards", async () => {
      await snap(page, "20-main", mainRow(page), "↑2");
      await snap(page, "21-resting", cardOf(row(page, B.resting)), "≡");
      await snap(page, "22-ahead", cardOf(row(page, B.ahead)), "↑2");
      await snap(page, "23-behind", cardOf(row(page, B.behind)), "↓4");
      await snap(page, "24-diverged", cardOf(row(page, B.both)), "↓3");
      await snap(page, "25-base-behind", cardOf(row(page, B.baseBehind)), "↓7");
      await snap(page, "26-local-only", cardOf(row(page, B.local)), "local");
      await snap(page, "27-local-resting", cardOf(row(page, B.localResting)), "local");
    });

    await step("tooltips", async () => {
      await snapTooltip(page, "30-tip-main", badgeIn(mainRow(page)), "upstream");
      await snapTooltip(page, "31-tip-resting", badgeIn(row(page, B.resting)), "In sync");
      await snapTooltip(page, "32-tip-ahead", badgeIn(row(page, B.ahead)), "ahead");
      await snapTooltip(page, "33-tip-diverged", badgeIn(row(page, B.both)), "behind");
      await snapTooltip(page, "34-tip-base-behind", badgeIn(row(page, B.baseBehind)), "behind");
      await snapTooltip(page, "35-tip-local-only", badgeIn(row(page, B.local)), "No upstream");
    });

    // Keyboard: can the badge's detail be reached without a pointer? Tab from
    // the worktree search until focus lands on (or inside) the diverged card's
    // sync line. If it never does, record that as the finding rather than
    // faking a focus.
    await step("keyboard", async () => {
      await page.locator(SEL.worktree.searchInput).first().click();
      const target = badgeIn(row(page, B.both));
      let reached = false;
      for (let i = 0; i < 120 && !reached; i++) {
        await page.keyboard.press("Tab");
        reached = await target
          .evaluate((el) => el === document.activeElement || el.contains(document.activeElement))
          .catch(() => false);
      }
      writeFileSync(
        path.join(OUTPUT_DIR, "keyboard-reachability.txt"),
        reached
          ? "sync badge reachable by Tab\n"
          : "sync badge NOT reachable by Tab (120 presses)\n"
      );
      if (reached) {
        await settle(page, 600);
        await snap(page, "40-keyboard-focus", cardOf(row(page, B.both)));
      }
      await page.keyboard.press("Escape");
      await page.mouse.move(1600, 1000);
    });

    await step("narrow", async () => {
      const handle = page.locator('[role="separator"][aria-label^="Resize sidebar"]').first();
      await handle.focus();
      for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowLeft");
      await settle(page, 400);
      await snap(page, "50-narrow-sidebar", sidebar);
      await snap(page, "51-narrow-diverged", cardOf(row(page, B.both)), "↓3");
      for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
      await settle(page, 400);
    });

    // The value-change flash is an opacity dip. Commit in a worktree, wait for
    // the class, and freeze the animation at its trough so the frame is real.
    await step("flash", async () => {
      const polish = page.locator("style").filter({ hasText: "caret-color: transparent" });
      await polish.evaluateAll((nodes) => nodes.forEach((n) => n.remove()));
      const badge = badgeIn(row(page, B.ahead));
      // The dip lasts 200ms, far shorter than a poll round trip, so an
      // observer in the page pauses it the moment the class lands.
      await badge.evaluate((el) => {
        const w = window as unknown as { __syncFlashFrozen?: boolean };
        w.__syncFlashFrozen = false;
        const obs = new MutationObserver(() => {
          if (!el.classList.contains("animate-upstream-badge-flash")) return;
          const anim = el.getAnimations().find((a) => a instanceof CSSAnimation);
          if (!anim) return;
          anim.pause();
          anim.currentTime = 80;
          w.__syncFlashFrozen = true;
          obs.disconnect();
        });
        obs.observe(el, { attributes: true, attributeFilter: ["class"] });
      });
      const wt = path.join(path.dirname(fx.dir), "helios-worktrees", SLUG[B.ahead]);
      commits(wt, "flash", 1);
      await expect(badge).toContainText("↑3", { timeout: T_LONG * 2 });
      await expect
        .poll(
          () => page.evaluate(() => (window as { __syncFlashFrozen?: boolean }).__syncFlashFrozen),
          {
            timeout: T_LONG,
          }
        )
        .toBe(true);
      await snap(page, "60-flash-trough", cardOf(row(page, B.ahead)), "↑3", "allow");
      await badge.evaluate((el) => el.getAnimations().forEach((a) => a.finish()));
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    });

    // Theme sweep of the densest sidebar state.
    await step("themes", async () => {
      const themes = SWEEP_THEMES.length > 0 ? SWEEP_THEMES : DEFAULT_THEMES;
      for (const theme of themes) {
        await setAppTheme(page, theme);
        await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
        await dismissBlockingPalette(page);
        await expect(row(page, B.both)).toBeVisible({ timeout: T_LONG });
        await page.mouse.move(1600, 1000);
        await settle(page, 800);
        await snap(page, `T-${theme}`, sidebar);
        await snap(page, `T-${theme}-diverged`, cardOf(row(page, B.both)), "↓3");
      }
      // Every later state is judged on the default palette.
      await setAppTheme(page, "daintree");
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await dismissBlockingPalette(page);
    });
    // The degraded states cannot be produced reliably by real git inside a
    // capture run: auth is only confirmed after three failures spread over
    // 5- and 15-minute backoff windows, every fetch failure also sets
    // network-failed so "stale but healthy" never occurs on its own, and a
    // forced fetch inside the recency window of the last success is skipped
    // without running git at all. Both
    // go through the renderer's own data seam instead: the worktree
    // MessagePort is replaced with one that answers `get-all-states` with
    // the real snapshots, patched, and then streams `worktree-update` events
    // exactly as the workspace host would. Real updates stop at the swap, so
    // this runs last.
    await step("patched", async () => {
      const real = await page.evaluate(() =>
        (
          window as unknown as {
            electron: { worktreePort: { request: (a: string) => Promise<unknown> } };
          }
        ).electron.worktreePort.request("get-all-states")
      );
      const snapshot = real as { states: Snapshot[]; epoch: string; seq: number };
      const byBranch = (b: string) => snapshot.states.find((s) => s.branch === b);
      if (!byBranch(B.both)) throw new Error("patched: no snapshot for the diverged card");
      const lastGood = Date.now() - 90_000;
      const authStates = snapshot.states.map((s) => ({
        ...s,
        fetchAuthFailed: true,
        fetchNetworkFailed: false,
        isFetchInFlight: false,
        lastFetchedAt: lastGood,
        matchedForgeProviderId: "daintree.github:github",
      }));
      await ctx!.app.evaluate(
        ({ webContents, MessageChannelMain }, data) => {
          const g = globalThis as Record<string, unknown>;
          const has = g.__daintreeWorktreeHasPort as ((id: number) => boolean) | undefined;
          if (!has) throw new Error("fault mode is off — __daintreeWorktreeHasPort missing");
          const wc = webContents.getAllWebContents().find((w) => has(w.id));
          if (!wc) throw new Error("no webContents holds a worktree port");
          const { port1, port2 } = new MessageChannelMain();
          g.__syncShotPort = port1;
          port1.on("message", (e) => {
            const d = e.data as { id?: string; action?: string };
            if (!d?.id) return;
            if (d.action === "get-all-states") {
              port1.postMessage({
                id: d.id,
                result: {
                  states: data.states,
                  epoch: data.epoch,
                  seq: data.seq,
                  watcherDegraded: false,
                  topologyWatcherDark: false,
                },
              });
            } else {
              port1.postMessage({ id: d.id, result: null });
            }
          });
          port1.start();
          wc.postMessage("worktree-port", {}, [port2]);
        },
        { states: authStates, epoch: snapshot.epoch, seq: snapshot.seq + 1 }
      );
      let seq = snapshot.seq + 1;
      const push = async (worktree: Snapshot) => {
        seq += 1;
        await ctx!.app.evaluate(
          (_m, d) => {
            const port = (globalThis as Record<string, unknown>).__syncShotPort as {
              postMessage: (m: unknown) => void;
            };
            port.postMessage({
              type: "event",
              event: { type: "worktree-update", worktree: d.worktree, epoch: d.epoch, seq: d.seq },
            });
          },
          { worktree, epoch: snapshot.epoch, seq }
        );
      };
      for (const s of authStates) await push(s);

      const badge = badgeIn(row(page, B.both));
      await expect(badge, "auth-failed pill never rendered").toHaveAttribute(
        "data-fetch-auth-failed",
        "true",
        { timeout: T_LONG }
      );
      await dismissToasts(page);
      await page.mouse.move(1600, 1000);
      await snap(page, "A0-auth-failed", cardOf(row(page, B.both)), "↓3");
      await snap(page, "A1-auth-failed-main", mainRow(page), "↑2");
      await snap(page, "A2-auth-failed-resting", cardOf(row(page, B.resting)), "develop");
      await snap(page, "A3-sidebar-auth-failed", sidebar);
      await snapTooltip(page, "A4-tip-auth-failed", badge, "authentication");

      // Stale but otherwise healthy: every card last fetched ten minutes ago,
      // past 1.5x both the active and background intervals. One card's base
      // compare is the local branch, the "Remote comparison unavailable" case.
      const tenMinutesAgo = Date.now() - 10 * 60_000;
      for (const s of snapshot.states) {
        await push({
          ...s,
          fetchAuthFailed: false,
          fetchNetworkFailed: false,
          isFetchInFlight: false,
          lastFetchedAt: tenMinutesAgo,
          ...(s.branch === B.baseBehind ? { baseCompareRef: BASE } : {}),
          // A fetch in flight suspends the stale treatment on its own card.
          ...(s.branch === B.ahead ? { isFetchInFlight: true } : {}),
        });
      }
      await expect(badge, "stale never rendered").toHaveAttribute("data-stale", "true", {
        timeout: T_LONG,
      });
      await page.mouse.move(1600, 1000);
      await snap(page, "B0-stale", cardOf(row(page, B.both)), "↓3");
      await snap(page, "B1-sidebar-stale", sidebar);
      await snap(page, "B4-in-flight", cardOf(row(page, B.ahead)), "↑2");
      await snapTooltip(page, "B2-tip-stale", badge, "Stale");
      await snapTooltip(
        page,
        "B3-tip-local-base",
        badgeIn(row(page, B.baseBehind)),
        "Remote comparison unavailable"
      );

      // Network failed: what a refused connection leaves behind — the flag,
      // and the last success still standing, now past the stale threshold.
      for (const s of snapshot.states) {
        await push({
          ...s,
          fetchAuthFailed: false,
          fetchNetworkFailed: true,
          isFetchInFlight: false,
          lastFetchedAt: tenMinutesAgo,
        });
      }
      await expect(badge, "network failure never rendered").toHaveAttribute(
        "data-fetch-network-failed",
        "true",
        { timeout: T_LONG }
      );
      await page.mouse.move(1600, 1000);
      await snap(page, "C0-network-failed", cardOf(row(page, B.both)), "↓3");
      await snap(page, "C1-sidebar-network-failed", sidebar);
      await snapTooltip(page, "C2-tip-network-failed", badge, "reach the remote");
    });
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    fx.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  const onDisk = readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png"));
  console.log(`[sync-shots] wrote ${written.size} shots; ${onDisk.length} PNGs on disk`);
  if (written.size === 0) throw new Error("[sync-shots] produced no screenshots at all");
  if (stepFailures.length > 0) {
    throw new Error(
      `[sync-shots] ${stepFailures.length} step(s) failed:\n${stepFailures.join("\n")}`
    );
  }
});

async function dismissToasts(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await page
    .locator('[data-sonner-toast] button[aria-label="Close"], [data-toast] [aria-label*="Dismiss"]')
    .evaluateAll((nodes) => nodes.forEach((n) => (n as HTMLElement).click()))
    .catch(() => {});
  await page.waitForTimeout(200);
}
