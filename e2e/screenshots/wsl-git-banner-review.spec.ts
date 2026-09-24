/**
 * `WslGitBanner` visual-review harness — the inline note a worktree card shows
 * when its checkout lives on a WSL mount.
 *
 * WSL paths only exist on Windows, so every banner state goes through the
 * renderer's own data seam: the worktree MessagePort is replaced with one that
 * answers `get-all-states` with the real snapshots, patched with the WSL
 * fields, and then streams `worktree-update` events exactly as the workspace
 * host would. The re-check failure and in-flight states swap the
 * `worktree-config:reprobe-wsl` handler in main for one that rejects or hangs.
 *
 * Opt-in: skips itself unless DAINTREE_SHOT_WSL is set.
 *
 *   DAINTREE_SHOT_WSL=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     npx playwright test --project=screenshots wsl-git-banner-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_WSL      required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR     output dir (default artifacts/wsl-banner-shots, gitignored)
 *   DAINTREE_SHOT_ONLY     comma-separated step filter
 *   DAINTREE_SHOT_THEMES   comma-separated theme sweep (default: a light/dark spread)
 *
 * Nothing is written that has not been verified: `snap()` asserts the target
 * is visible, has a real box and carries the state's own content first.
 */

import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
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

const ENABLED = !!process.env.DAINTREE_SHOT_WSL;
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : path.resolve(process.cwd(), "artifacts", "wsl-banner-shots");

const DEFAULT_THEMES = ["daintree", "namib", "redwoods", "bondi", "svalbard", "hokkaido"];
const SWEEP_THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after {
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
  /* The floating "N more above/below" pills sit over whichever card is centred. */
  [data-sidebar-scroll-indicator] { visibility: hidden !important; }
`;

const BASE = "develop";
const REPROBE_CHANNEL = "worktree-config:reprobe-wsl";

/** Card branches, each patched into one banner state. */
const B = {
  eligible: "feature/wsl-eligible",
  noDistro: "feature/wsl-no-distro",
  ineligible: "feature/wsl-other-distro",
  longDistro: "feature/wsl-long-distro",
  probing: "feature/wsl-probing",
} as const;

type Snapshot = { branch?: string } & Record<string, unknown>;

const WSL_PATCH: Record<string, Record<string, unknown>> = {
  [B.eligible]: { isWslPath: true, wslDistro: "Ubuntu-24.04", wslGitEligible: "eligible" },
  [B.noDistro]: { isWslPath: true, wslDistro: undefined, wslGitEligible: "eligible" },
  [B.ineligible]: { isWslPath: true, wslDistro: "Debian", wslGitEligible: "ineligible" },
  [B.longDistro]: {
    isWslPath: true,
    wslDistro: "Ubuntu-22.04-platform-engineering",
    wslGitEligible: "ineligible",
  },
};
const PROBING_PATCH = { isWslPath: true, wslDistro: "Ubuntu-24.04", wslGitEligible: "unprobed" };

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString();
}

function createFixture(): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "daintree-wslshots-"));
  const dir = path.join(root, "helios");
  const wtRoot = path.join(root, "helios-worktrees");
  mkdirSync(dir);
  mkdirSync(wtRoot);
  git(`init -q -b ${BASE}`, dir);
  git('config user.email "avery@helios.dev"', dir);
  git('config user.name "Avery Lindqvist"', dir);
  writeFileSync(path.join(dir, "README.md"), "# Helios\n");
  git("add -A", dir);
  git('commit -q -m "Initial commit"', dir);
  for (const branch of Object.values(B)) {
    const wt = path.join(wtRoot, branch.split("/")[1]);
    git(`worktree add -q -b ${branch} "${wt}" ${BASE}`, dir);
  }
  return {
    dir,
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
    console.warn(`[wsl-shots] step "${name}" FAILED:`, detail);
  }
}

async function snap(
  page: Page,
  slug: string,
  target: Locator,
  expectText?: string | RegExp
): Promise<void> {
  await settle(page);
  await expect(target, `"${slug}": target never became visible — refusing to write`).toBeVisible({
    timeout: T_LONG,
  });
  await target.scrollIntoViewIfNeeded();
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
    animations: "disabled",
    caret: "hide",
  });
  written.add(`${slug}.png`);
}

const row = (page: Page, branch: string): Locator => page.locator(SEL.worktree.row(branch)).first();

/** The card list is virtualized: scroll it until the branch's row is mounted. */
async function reveal(page: Page, branch: string): Promise<Locator> {
  const r = row(page, branch);
  for (const dir of [1, -1]) {
    for (let i = 0; i < 40; i++) {
      // The virtualizer can unmount a row between the count and the scroll,
      // so a short-timeout attempt that fails just keeps scrolling.
      const centred = await r
        .evaluate((el) => el.scrollIntoView({ block: "center" }), undefined, { timeout: 1500 })
        .then(() => true)
        .catch(() => false);
      if (centred) {
        await settle(page, 250);
        if ((await r.count()) > 0) return r;
      }
      await page.evaluate((d) => {
        document
          .querySelector('aside[aria-label="Sidebar"] [data-virtuoso-scroller]')
          ?.scrollBy(0, d * 240);
      }, dir);
      await settle(page, 120);
    }
  }
  throw new Error(`card ${branch} never mounted`);
}
const cardOf = (r: Locator): Locator => r.locator(".sidebar-worktree-card").first();
const bannerIn = (r: Locator): Locator => r.locator('[data-testid="wsl-git-banner"]').first();

/**
 * Swap the worktree port for one that serves the real snapshots with the WSL
 * patch applied. Returns a `push` that streams one snapshot as an update.
 */
async function installWslPort(
  app: ElectronApplication,
  page: Page,
  withProbing: boolean
): Promise<{ push: (s: Snapshot) => Promise<void>; byBranch: (b: string) => Snapshot }> {
  const real = (await page.evaluate(() =>
    (
      window as unknown as {
        electron: { worktreePort: { request: (a: string) => Promise<unknown> } };
      }
    ).electron.worktreePort.request("get-all-states")
  )) as { states: Snapshot[]; epoch: string; seq: number };
  const patch = (s: Snapshot): Snapshot => {
    if (s.branch && WSL_PATCH[s.branch]) return { ...s, ...WSL_PATCH[s.branch] };
    if (withProbing && s.branch === B.probing) return { ...s, ...PROBING_PATCH };
    return s;
  };
  const states = real.states.map(patch);
  for (const b of Object.keys(WSL_PATCH)) {
    if (!states.some((s) => s.branch === b)) throw new Error(`no snapshot for ${b}`);
  }
  await app.evaluate(
    ({ webContents, MessageChannelMain }, data) => {
      const g = globalThis as Record<string, unknown>;
      const has = g.__daintreeWorktreeHasPort as ((id: number) => boolean) | undefined;
      if (!has) throw new Error("fault mode is off — __daintreeWorktreeHasPort missing");
      const wc = webContents.getAllWebContents().find((w) => has(w.id));
      if (!wc) throw new Error("no webContents holds a worktree port");
      const { port1, port2 } = new MessageChannelMain();
      g.__wslShotPort = port1;
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
    { states, epoch: real.epoch, seq: real.seq + 1 }
  );
  let seq = real.seq + 1;
  const push = async (worktree: Snapshot) => {
    seq += 1;
    await app.evaluate(
      (_m, d) => {
        const port = (globalThis as Record<string, unknown>).__wslShotPort as {
          postMessage: (m: unknown) => void;
        };
        port.postMessage({
          type: "event",
          event: { type: "worktree-update", worktree: d.worktree, epoch: d.epoch, seq: d.seq },
        });
      },
      { worktree, epoch: real.epoch, seq }
    );
  };
  for (const s of states) await push(s);
  const byBranch = (b: string) => {
    const s = real.states.find((x) => x.branch === b);
    if (!s) throw new Error(`no snapshot for ${b}`);
    return s;
  };
  return { push, byBranch };
}

/** Replace the reprobe handler: "reject" fails, "hang" parks until released. */
async function setReprobe(app: ElectronApplication, mode: "reject" | "hang" | "ok"): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, d) => {
      const g = globalThis as Record<string, unknown>;
      ipcMain.removeHandler(d.channel);
      ipcMain.handle(d.channel, () => {
        if (d.mode === "reject") return Promise.reject(new Error("wsl.exe not found"));
        if (d.mode === "hang")
          return new Promise<void>((_res, rej) => {
            g.__wslReleaseReprobe = () => rej(new Error("wsl.exe not found"));
          });
        return undefined;
      });
    },
    { channel: REPROBE_CHANNEL, mode }
  );
}

async function releaseReprobe(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const release = (globalThis as Record<string, unknown>).__wslReleaseReprobe as
      (() => void) | undefined;
    release?.();
  });
}

async function expandCards(page: Page): Promise<void> {
  for (const branch of Object.values(B)) {
    const r = await reveal(page, branch);
    const toggle = r.locator('[aria-controls^="worktree-body-"]').first();
    if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-expanded")) === "false") {
      await toggle.click();
    }
  }
}

test("wsl git banner review — states and themes", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_WSL is required for the WSL banner capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_WSL to run the WSL banner capture");
  test.setTimeout(15 * 60_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const fx = createFixture();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-wslshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      env: { GIT_TERMINAL_PROMPT: "0", DAINTREE_E2E_FAULT_MODE: "1" },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const app = ctx.app;
    const page = await openAndOnboardProject(app, ctx.window, fx.dir, "Helios");
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    const sidebar = page.locator(SEL.sidebar.aside).first();

    await expandCards(page);
    await settle(page, 1200);
    let port = await installWslPort(app, page, false);
    await expect(
      bannerIn(await reveal(page, B.eligible)),
      "eligible banner never rendered"
    ).toBeVisible({
      timeout: T_LONG,
    });
    await page.mouse.move(1600, 1000);

    await step("rest", async () => {
      await snap(page, "10-sidebar", sidebar);
      await snap(page, "20-eligible", cardOf(await reveal(page, B.eligible)), "Ubuntu-24.04");
      await snap(page, "21-eligible-no-distro", cardOf(await reveal(page, B.noDistro)));
      await snap(page, "22-ineligible", cardOf(await reveal(page, B.ineligible)), "Debian");
      await snap(
        page,
        "23-ineligible-long-distro",
        cardOf(await reveal(page, B.longDistro)),
        "Ubuntu"
      );
    });

    // Mount the probing card's banner now, so its deferred-loading clocks
    // start here: the skeleton lands after the Doherty gate, the recovery
    // state after the stuck threshold.
    await step("probing", async () => {
      await port.push({ ...port.byBranch(B.probing), ...PROBING_PATCH });
      const banner = bannerIn(await reveal(page, B.probing));
      await expect(banner, "skeleton never rendered").toHaveAttribute("aria-busy", "true", {
        timeout: 3000,
      });
      await snap(page, "30-probing-skeleton", cardOf(await reveal(page, B.probing)));
      await expect(banner, "stuck state never rendered").not.toHaveAttribute("aria-busy", "true", {
        timeout: 10_000,
      });
      await snap(page, "31-probe-stuck", cardOf(await reveal(page, B.probing)));
    });

    // The primary action is the first button in every state; address it by
    // position so the harness survives copy changes.
    const primaryIn = async (branch: string) =>
      bannerIn(await reveal(page, branch))
        .getByRole("button")
        .first();

    await step("reprobe", async () => {
      const probing = bannerIn(await reveal(page, B.probing));
      await setReprobe(app, "hang");
      await (await primaryIn(B.probing)).click();
      await page.mouse.move(1600, 1000);
      await expect(probing, "re-check never went busy").toHaveAttribute("aria-busy", "true");
      await snap(page, "32-probe-rechecking", cardOf(await reveal(page, B.probing)));
      await releaseReprobe(app);
      await expect(probing, "failed re-check never settled").not.toHaveAttribute(
        "aria-busy",
        "true"
      );
      await snap(page, "33-probe-recheck-failed", cardOf(await reveal(page, B.probing)));

      // No host answer at all: off Windows the host ignores the request, which
      // is exactly what a probe that fails silently looks like to the banner.
      await setReprobe(app, "ok");
      await (await primaryIn(B.probing)).click();
      await expect(probing, "no-answer re-check never settled").not.toHaveAttribute(
        "aria-busy",
        "true",
        { timeout: 12_000 }
      );
      await snap(page, "35-probe-no-answer", cardOf(await reveal(page, B.probing)));

      await setReprobe(app, "reject");
      await (await primaryIn(B.ineligible)).click();
      await page.mouse.move(1600, 1000);
      await snap(
        page,
        "34-ineligible-recheck-failed",
        cardOf(await reveal(page, B.ineligible)),
        "Debian"
      );

      // A re-check the host answers with the same verdict: it flips the
      // monitor to unprobed while probing, then back.
      await setReprobe(app, "ok");
      const longBanner = bannerIn(await reveal(page, B.longDistro));
      await (await primaryIn(B.longDistro)).click();
      await port.push({
        ...port.byBranch(B.longDistro),
        ...WSL_PATCH[B.longDistro],
        wslGitEligible: "unprobed",
      });
      await expect(longBanner, "re-check hold never went busy").toHaveAttribute(
        "aria-busy",
        "true"
      );
      await page.mouse.move(1600, 1000);
      await snap(
        page,
        "36-ineligible-rechecking",
        cardOf(await reveal(page, B.longDistro)),
        "Ubuntu"
      );
      await port.push({ ...port.byBranch(B.longDistro), ...WSL_PATCH[B.longDistro] });
      await expect(longBanner, "unchanged re-check never settled").not.toHaveAttribute(
        "aria-busy",
        "true"
      );
      await snap(
        page,
        "37-ineligible-recheck-unchanged",
        cardOf(await reveal(page, B.longDistro)),
        "Ubuntu"
      );
    });

    await step("interaction", async () => {
      const banner = bannerIn(await reveal(page, B.eligible));
      const buttons = banner.getByRole("button");
      await buttons.first().hover();
      await snap(page, "40-eligible-hover-primary", cardOf(await reveal(page, B.eligible)));
      await page.mouse.move(1600, 1000);
      // Keyboard modality, then programmatic focus, so :focus-visible matches.
      await page.keyboard.press("Shift");
      await buttons.first().focus();
      await snap(page, "41-eligible-focus-primary", cardOf(await reveal(page, B.eligible)));
      await buttons.last().focus();
      await snap(page, "42-eligible-focus-secondary", cardOf(await reveal(page, B.eligible)));
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

      // Does pressing a banner button also select the card underneath it?
      await setReprobe(app, "ok");
      const target = await reveal(page, B.longDistro);
      const isActive = () => target.evaluate((el) => !!el.querySelector('[data-active="true"]'));
      const before = await isActive();
      await bannerIn(target)
        .getByRole("button", { name: /re-check/i })
        .click();
      await settle(page, 300);
      const after = await isActive();
      writeFileSync(
        path.join(OUTPUT_DIR, "click-through.txt"),
        `pressing Re-check on an inactive card: active before=${before} after=${after}\n`
      );
      await page.mouse.move(1600, 1000);
    });

    await step("narrow", async () => {
      const handle = page.locator('[role="separator"][aria-label^="Resize sidebar"]').first();
      await handle.focus();
      for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowLeft");
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await settle(page, 400);
      await snap(
        page,
        "50-narrow-eligible",
        cardOf(await reveal(page, B.eligible)),
        "Ubuntu-24.04"
      );
      await snap(page, "51-narrow-ineligible", cardOf(await reveal(page, B.ineligible)), "Debian");
      await handle.focus();
      for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await settle(page, 400);
    });

    await step("themes", async () => {
      const themes = SWEEP_THEMES.length > 0 ? SWEEP_THEMES : DEFAULT_THEMES;
      for (const theme of themes) {
        await setAppTheme(page, theme);
        await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
        await dismissBlockingPalette(page);
        await expandCards(page);
        await settle(page, 800);
        port = await installWslPort(app, page, true);
        await expect(bannerIn(await reveal(page, B.eligible))).toBeVisible({ timeout: T_LONG });
        await page.mouse.move(1600, 1000);
        await snap(
          page,
          `T-${theme}-eligible`,
          cardOf(await reveal(page, B.eligible)),
          "Ubuntu-24.04"
        );
        await snap(
          page,
          `T-${theme}-ineligible`,
          cardOf(await reveal(page, B.ineligible)),
          "Debian"
        );
        await expect(bannerIn(await reveal(page, B.probing))).toHaveAttribute(
          "data-state",
          "stuck",
          {
            timeout: 10_000,
          }
        );
        await snap(page, `T-${theme}-stuck`, cardOf(await reveal(page, B.probing)));
      }
      await setAppTheme(page, "daintree");
    });
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    fx.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  const onDisk = readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png"));
  console.log(`[wsl-shots] wrote ${written.size} shots; ${onDisk.length} PNGs on disk`);
  if (written.size === 0) throw new Error("[wsl-shots] produced no screenshots at all");
  if (stepFailures.length > 0) {
    throw new Error(
      `[wsl-shots] ${stepFailures.length} step(s) failed:\n${stepFailures.join("\n")}`
    );
  }
});
