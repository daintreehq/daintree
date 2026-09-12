/**
 * Toolbar strip visual-review harness.
 *
 * Drives the main toolbar — `src/components/Layout/Toolbar.tsx`, the 48px strip
 * on screen in every window all day — through the states that carry design
 * weight and writes a full-width PNG of the strip for each. The five dropdowns
 * it hosts have their own harnesses; this one is about the strip as a composed
 * whole: grouping, dividers, the overflow engine and its severity badge, the
 * project pill's degradation, the platform spacers, and where keyboard focus
 * goes when the button it was on is evicted.
 *
 * There is no canonical composition — every button is user-hideable and
 * user-movable — so two compositions are captured: a rich default-shaped one
 * with live signals, and a deliberately re-shuffled one that puts utilities on
 * the left and panels on the right, so the grouping and divider rules can be
 * judged on both sides.
 *
 * Signals are pushed through the seams the app already uses, never faked in
 * CSS: a fake `claude` on PATH drives the real agent-state FSM to `waiting`,
 * the E2E error bridge feeds the problems count, the notification backdoor
 * seeds unread history, and a github.com remote resolves the forge pill.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_THEME is set, so neither the
 * marketing screenshots workflow nor a bare `--project=screenshots` runs it.
 *
 *   DAINTREE_SHOT_THEME=daintree DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots toolbar-strip-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_THEME  required — theme id to render (e.g. daintree, bondi)
 *   DAINTREE_SHOT_DIR    required — absolute output dir. Deliberately no default:
 *                        the spec is committed, and an in-repo fallback would
 *                        outlive the run and put PNGs into someone's tree.
 *   DAINTREE_SHOT_TAG    optional suffix to keep before/after rounds side by side
 *   DAINTREE_SHOT_ONLY   comma-separated step filter (see STEPS below)
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 2)
 *
 * Output: <dir>/<theme>/<NN-slug>[-tag].png
 */

import { expect, test, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, existsSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { createFixtureRepo } from "../helpers/fixtures";
import { installFakeAgent, fakeAgentEnv, ptyWrite, FAKE_AGENT_IDLE } from "../helpers/fakeAgent";
import { FAKE_AGENT_READY } from "../helpers/fakeAgent";
import { getTerminalText, waitForTerminalText, writeTerminalInput } from "../helpers/terminal";
import { getGridPanelIds } from "../helpers/panels";
import { seedNotificationHistory } from "../helpers/notifications";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const SHOT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const OUTPUT_DIR = path.join(SHOT_DIR || "unset", THEME || "unset");

const STRIP = '[role="toolbar"][aria-label="Main toolbar"]';
const OVERFLOW_TRIGGER = (side: "left" | "right") =>
  `[data-toolbar-overflow-trigger][data-toolbar-overflow-side="${side}"][data-visible="true"]`;
const BUTTON = (id: string) => `[data-toolbar-button-id="${id}"] button`;

const WIDE = { width: 1680, height: 1050 };
const PROJECT_NAME = "Helios Dashboard";
const LONG_PROJECT_NAME = "Helios Dashboard Platform Services";
const LONG_BRANCH = "feature/oauth-device-flow-with-refresh-token-rotation";

/**
 * Every shot this harness owes, in capture order. Kept as data rather than
 * spelled only inside the steps so the run can count what actually landed on
 * disk against what was promised — an exit code alone has never been evidence
 * that a capture harness produced anything.
 */
const STEPS = [
  { name: "no-workspace", slug: "01-no-workspace" },
  { name: "rest", slug: "02-rest-default" },
  { name: "signals", slug: "03-signals-wide" },
  { name: "hover", slug: "04-hover" },
  { name: "focus", slug: "05-focus-visible" },
  { name: "armed", slug: "06-armed-launcher" },
  { name: "overflow-mild", slug: "07-overflow-mild" },
  { name: "overflow-severe", slug: "08-overflow-severe" },
  { name: "overflow-extreme", slug: "09-overflow-extreme" },
  { name: "overflow-menu", slug: "10-overflow-menu-open" },
  { name: "eviction", slug: "11-eviction-focus-redirect" },
  { name: "long-names", slug: "12-long-names" },
  { name: "forced-colors", slug: "13-forced-colors" },
  { name: "contrast-more", slug: "14-contrast-more" },
  { name: "composition-alt", slug: "15-composition-alt" },
  { name: "composition-alt-overflow", slug: "16-composition-alt-overflow" },
  { name: "platform-windows", slug: "17-platform-windows" },
  { name: "platform-linux", slug: "18-platform-linux" },
  { name: "fullscreen", slug: "19-fullscreen-mac" },
] as const;

// Freeze animations and hide carets so captures are deterministic. Badges and
// the overflow trigger animate in; a mid-transition frame reads as a design
// flaw that isn't there.
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

// The rich composition: launcher, a pinned agent, every panel button on the
// left; the full default utility set on the right. Enough buttons that
// overflow has real work to do at 1180px and every group boundary draws.
const RICH_LEFT = ["launcher", "claude", "terminal", "browser", "file-browser", "dev-server"];
const RICH_RIGHT = [
  "voice-recording",
  "forge-stats",
  "plugin-tray",
  "notification-center",
  "copy-tree",
  "resume-sessions",
  "command-palette",
  "settings",
  "problems",
];

// The re-shuffled composition: utilities interleaved on the left, panels and
// the agent on the right. The persisted order is deliberately NOT grouped —
// the toolbar is supposed to regroup it at render, and the capture shows
// whether it does so on both sides.
const ALT_LEFT = ["settings", "launcher", "problems", "terminal", "notification-center"];
const ALT_RIGHT = [
  "file-browser",
  "voice-recording",
  "claude",
  "forge-stats",
  "browser",
  "copy-tree",
  "command-palette",
  "resume-sessions",
  "dev-server",
  "plugin-tray",
];

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/**
 * A JSON sidecar beside every PNG: which buttons each side shows and hides,
 * whether each `…` trigger is up, the measured row's box against the boxes of
 * the buttons it holds, and the device pixel ratio the PNG was rendered at.
 * Pixels cannot tell an evicted button from one the row's overflow-hidden has
 * simply clipped; the rects can.
 */
async function dumpStripState(page: Page, slug: string): Promise<void> {
  const state = await page.evaluate((strip) => {
    const root = document.querySelector<HTMLElement>(strip);
    if (!root) return null;
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const sides = ["left", "right"].map((side) => {
      const trigger = root.querySelector<HTMLElement>(
        `[data-toolbar-overflow-trigger][data-toolbar-overflow-side="${side}"]`
      );
      const row = trigger?.parentElement?.previousElementSibling as HTMLElement | null;
      const rowRect = row ? rect(row) : null;
      const items = row
        ? Array.from(row.querySelectorAll<HTMLElement>("[data-toolbar-button-id]")).map((el) => {
            const r = rect(el);
            const hidden = el.getAttribute("aria-hidden") === "true";
            const clipped =
              !hidden &&
              rowRect !== null &&
              (r.x < rowRect.x - 1 || r.x + r.w > rowRect.x + rowRect.w + 1);
            return { id: el.getAttribute("data-toolbar-button-id"), hidden, clipped, ...r };
          })
        : [];
      const dividers = row
        ? Array.from(row.querySelectorAll<HTMLElement>(".toolbar-divider")).map((el) => ({
            ...rect(el),
            painted: getComputedStyle(el).display !== "none" && rect(el).h > 0,
          }))
        : [];
      return {
        side,
        dividers,
        triggerVisible: trigger?.getAttribute("data-visible") === "true",
        triggerSeverity: trigger?.querySelector("[data-severity]")?.getAttribute("data-severity"),
        row: rowRect,
        items,
      };
    });
    const pill = root.querySelector('[data-testid="project-switcher-trigger"]');
    return {
      devicePixelRatio: window.devicePixelRatio,
      viewport: window.innerWidth,
      strip: rect(root),
      pill: pill ? { ...rect(pill), text: pill.textContent } : null,
      activeElement:
        document.activeElement === document.body
          ? "body"
          : (document.activeElement?.getAttribute("aria-label") ??
            document.activeElement?.tagName ??
            null),
      sides,
    };
  }, STRIP);
  writeFileSync(path.join(OUTPUT_DIR, `${slug}${TAG}.json`), JSON.stringify(state, null, 2));
}

/**
 * Full-width crop of the strip plus a little of what sits under it, so the
 * bottom border and the surface tint read against their real neighbour. A pad
 * of 0 at the top: the strip is the window's top edge.
 *
 * Throws when the file did not land. A harness that writes a success artifact
 * it has not verified is worse than one that fails.
 */
async function snapStrip(page: Page, slug: string, padBottom = 14): Promise<void> {
  await settle(page);
  const box = await page.locator(STRIP).first().boundingBox();
  if (!box) throw new Error(`no bounding box for ${STRIP}`);
  const viewport = page.viewportSize() ?? WIDE;
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  await dumpStripState(page, slug);
  await page.screenshot({
    path: file,
    type: "png",
    scale: "device",
    animations: "disabled",
    caret: "hide",
    clip: {
      x: 0,
      y: 0,
      width: viewport.width,
      height: Math.min(box.y + box.height + padBottom, viewport.height),
    },
  });
  if (!existsSync(file)) throw new Error(`screenshot did not land at ${file}`);
}

/**
 * Run a capture step. A failure never stops the remaining shots — one missing
 * state should not cost the whole sweep — but it IS recorded, and the test
 * fails at the end. Every step leaves the viewport wide and the media
 * emulation cleared, so a step that dies mid-flight cannot poison the next.
 */
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const stepFailures: string[] = [];
async function step(page: Page | null, name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).split("\n")[0];
    console.warn(`[toolbar-shots] step "${name}" FAILED:`, detail);
    stepFailures.push(`${name}: ${detail}`);
  }
  if (page) {
    await page.keyboard.press("Escape").catch(() => {});
    // A keyboard-closed dropdown hands focus back to its trigger with a
    // focus-visible ring, which would then sit in every later capture.
    await page
      .evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      .catch(() => {});
    await page.emulateMedia({ forcedColors: "none", contrast: "no-preference" }).catch(() => {});
    await page.setViewportSize(WIDE).catch(() => {});
    // A step that clicked a button leaves the pointer on it, and the next
    // capture would show that button hovered.
    await page.mouse.move(WIDE.width / 2, WIDE.height - 20).catch(() => {});
    await settle(page, 300).catch(() => {});
  }
}

/** Reload and wait for the toolbar to be back, mirroring `setAppTheme`'s waits. */
async function reloadAndWait(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(SEL.toolbar.toggleSidebar).waitFor({ state: "visible", timeout: T_LONG });
  await page
    .locator(SEL.toolbar.projectSwitcherTrigger)
    .waitFor({ state: "visible", timeout: T_LONG });
  await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
  await dismissBlockingPalette(page);
  await settle(page, 800);
}

/**
 * Seeds the persisted toolbar layout and developer-tools preference, then
 * reloads so the stores rehydrate from it. Both stores merge a partial blob
 * over their defaults, so only the keys under review need writing.
 */
async function seedComposition(page: Page, left: string[], right: string[]): Promise<void> {
  await page.evaluate(
    ({ left, right }) => {
      localStorage.setItem(
        "daintree-toolbar-preferences",
        JSON.stringify({
          state: { layout: { leftButtons: left, rightButtons: right, pinnedButtons: {} } },
          version: 14,
        })
      );
      localStorage.setItem(
        "daintree-preferences",
        JSON.stringify({ state: { showDeveloperTools: true }, version: 20 })
      );
    },
    { left, right }
  );
  await reloadAndWait(page);
}

/** Error count → the problems badge; unread history → the notification dot. */
async function seedSignals(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __DAINTREE_E2E_ADD_ERROR__?: (m: string) => void };
    if (!w.__DAINTREE_E2E_ADD_ERROR__) throw new Error("E2E error bridge not attached");
    w.__DAINTREE_E2E_ADD_ERROR__("Dev server exited with code 1");
    w.__DAINTREE_E2E_ADD_ERROR__("Failed to read .env: EACCES");
    w.__DAINTREE_E2E_ADD_ERROR__("Recipe 'Review' references a missing preset");
  });
  const now = Date.now();
  await seedNotificationHistory(page, [
    {
      id: "toolbar-shot-1",
      type: "info",
      title: "PR #12384 merged",
      message: "Menu rows no longer ring on hover",
      timestamp: now - 90_000,
    },
    {
      id: "toolbar-shot-2",
      type: "warning",
      title: "Watcher degraded",
      message: "Falling back to polling for feature/oauth-device-flow",
      timestamp: now - 30_000,
    },
  ]);
  await settle(page, 500);
  await expect(
    page.locator(`${BUTTON("problems")} .toolbar-problems-badge[data-visible="true"]`),
    "problems badge did not light — refusing to capture a signals state without it"
  ).toBeAttached({ timeout: 5000 });
}

/**
 * Launches the pinned fake `claude` from its toolbar button and drives it to
 * `waiting` — the loudest state the agent pip can show. Returns the panel id.
 */
async function launchWaitingAgent(page: Page): Promise<string> {
  const before = new Set(await getGridPanelIds(page));
  await page.locator(BUTTON("claude")).first().click();
  let panelId: string | null = null;
  for (let i = 0; i < 60 && !panelId; i++) {
    const ids = await getGridPanelIds(page).catch(() => [] as string[]);
    panelId = ids.find((id) => !before.has(id)) ?? null;
    if (!panelId) await page.waitForTimeout(250);
  }
  if (!panelId) throw new Error("agent panel never appeared after clicking the claude button");
  const panel = page.locator(`[data-panel-id="${panelId}"]`);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const text = (await getTerminalText(panel).catch(() => "")).toLowerCase();
    if (text.includes(FAKE_AGENT_READY.toLowerCase())) break;
    if (text.includes("enter to confirm") || text.includes("trust this folder")) {
      await writeTerminalInput(page, panel, "\r").catch(() => {});
      break;
    }
    await page.waitForTimeout(250);
  }
  await waitForTerminalText(panel, FAKE_AGENT_READY, T_LONG);
  await expect
    .poll(() => panel.getAttribute("data-agent-state"), { timeout: T_LONG })
    .toBe("working");
  const wrote = await ptyWrite(page, panelId, `${FAKE_AGENT_IDLE}\r`);
  if (!wrote) throw new Error("terminal.write unavailable — cannot drive the agent to waiting");
  // The idle debounce that settles `working` into `waiting` runs longer than
  // T_LONG on a loaded machine; the theme tour gives it 2x and still warns.
  await expect
    .poll(() => panel.getAttribute("data-agent-state"), {
      timeout: T_LONG * 3,
      intervals: [500, 1000],
    })
    .toBe("waiting");
  // The toolbar reads dominant state per worktree, so the pip lags the panel
  // by a store tick.
  // The pip's colour follows the waiting state one store tick behind the
  // panel; a capture taken on the working colour would mislabel the state.
  await expect
    .poll(
      () =>
        page
          .locator(`${BUTTON("claude")} .toolbar-pip[data-visible="true"]`)
          .first()
          .getAttribute("class"),
      { timeout: 10_000, message: "agent pip never took the waiting colour" }
    )
    .toContain("waiting");
  return panelId;
}

async function expectOverflow(page: Page, side: "left" | "right"): Promise<void> {
  await expect(
    page.locator(OVERFLOW_TRIGGER(side)),
    `${side} overflow trigger is not visible — the width did not evict anything`
  ).toBeVisible({ timeout: 5000 });
}

async function expectNoOverflow(page: Page): Promise<void> {
  await expect(page.locator(OVERFLOW_TRIGGER("left"))).toHaveCount(0);
  await expect(page.locator(OVERFLOW_TRIGGER("right"))).toHaveCount(0);
}

/** `navigator.platform` drives the mac/windows/linux branches; CDP can lie about it. */
async function overridePlatform(
  page: Page,
  platform: "Win32" | "Linux x86_64" | "MacIntel"
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const base = await page.evaluate(() => navigator.userAgent);
  const userAgent =
    platform === "Win32"
      ? base.replace(/\(Macintosh;[^)]*\)/, "(Windows NT 10.0; Win64; x64)")
      : platform === "Linux x86_64"
        ? base.replace(/\(Macintosh;[^)]*\)/, "(X11; Linux x86_64)")
        : base;
  await cdp.send("Emulation.setUserAgentOverride", { userAgent, platform });
  await reloadAndWait(page);
}

test("toolbar strip review — every state of the strip", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_THEME is required for the toolbar-strip-review capture",
  });
  test.skip(!THEME, "Set DAINTREE_SHOT_THEME to run the toolbar-strip-review capture");
  if (!SHOT_DIR || !path.isAbsolute(SHOT_DIR)) {
    throw new Error("DAINTREE_SHOT_DIR must be an absolute directory outside the repo");
  }
  test.setTimeout(900_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo({
    name: "helios",
    withMultipleFiles: true,
    withFeatureBranch: true,
    withGitHubRemote: true,
  });
  // A second worktree on a long branch, so the chip's middle-truncation and
  // the pill's own truncation both have something to bite on.
  const wtRoot = path.join(path.dirname(repo.dir), path.basename(repo.dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });
  git(`branch ${LONG_BRANCH}`, repo.dir);
  git(
    `worktree add ${JSON.stringify(path.join(wtRoot, LONG_BRANCH.replace(/[/]/g, "-")))} ${LONG_BRANCH}`,
    repo.dir
  );
  const fakeBinDir = installFakeAgent(repo.dir);

  // Prefix deliberately avoids "daintree-e2e" — launchApp's pre-launch hygiene
  // pkills that pattern, and parallel theme captures would SIGKILL each other.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-toolbarshot-"));
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: WIDE,
      env: fakeAgentEnv(fakeBinDir),
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });

    // 1. No workspace. The welcome window's toolbar: disabled sidebar toggle,
    // a pill with nothing to name, the forge-stats measurement ghost. Captured
    // before any project is opened, because that is the only time it exists.
    // `setAppTheme` waits for the command input, which the welcome screen does
    // not have, so the theme is applied by hand here.
    await step(null, "no-workspace", async () => {
      const win = ctx!.window;
      await win.evaluate(async (id) => {
        await window.electron.appTheme.setColorScheme(id);
      }, THEME);
      await win.reload({ waitUntil: "domcontentloaded" });
      await win.locator(SEL.toolbar.toggleSidebar).waitFor({ state: "visible", timeout: T_LONG });
      await expect
        .poll(() => win.locator("html").getAttribute("data-theme"), { timeout: 10_000 })
        .toBe(THEME);
      await win.setViewportSize(WIDE);
      await win.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await dismissBlockingPalette(win);
      await settle(win, 1200);
      await expect(
        win.locator(`${SEL.toolbar.toggleSidebar}[aria-disabled="true"]`)
      ).toBeAttached();
      await snapStrip(win, "01-no-workspace");
    });

    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "helios");
    await page.evaluate(async (name) => {
      const cur = await window.electron.project.getCurrent();
      if (cur?.id) await window.electron.project.update(cur.id, { emoji: "☀️", name });
    }, PROJECT_NAME);
    await setAppTheme(page, THEME);
    await page.setViewportSize(WIDE);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await page
      .locator(SEL.worktree.mainCard)
      .waitFor({ state: "visible", timeout: T_LONG })
      .catch(() => {});
    await settle(page, 2000);
    await dismissBlockingPalette(page);

    // 2. Rest, default composition, nothing lit. The strip most users see most
    // of the time.
    await step(page, "rest", async () => {
      await expectNoOverflow(page);
      await snapStrip(page, "02-rest-default");
    });

    // The rich composition with every signal live, for everything that follows.
    await page.evaluate(() => window.electron.agentSettings.set("claude", { pinned: true }));
    await seedComposition(page, RICH_LEFT, RICH_RIGHT);
    await expect(page.locator(BUTTON("claude")).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(BUTTON("problems")).first()).toBeVisible({ timeout: 10_000 });
    await seedSignals(page);
    // Not a shot of its own, but a `step` so a fake agent that never settles
    // fails the run at the end instead of aborting every capture after it.
    await step(page, "agent-signal", async () => {
      await launchWaitingAgent(page);
    });
    await page.mouse.move(WIDE.width / 2, WIDE.height - 20);
    await settle(page, 600);

    // 3. Wide, all signals: agent waiting, three errors, two unread, forge pill.
    await step(page, "signals", async () => {
      await expectNoOverflow(page);
      await snapStrip(page, "03-signals-wide");
    });

    // 4. Hover on an icon button, so the hover tier can be judged against the
    // armed tier two shots down.
    await step(page, "hover", async () => {
      const box = await page.locator(BUTTON("settings")).first().boundingBox();
      if (!box) throw new Error("no bounding box for the settings button");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await settle(page, 500);
      await snapStrip(page, "04-hover");
      await page.mouse.move(WIDE.width / 2, WIDE.height - 20);
    });

    // 5. Keyboard focus, delivered by the keyboard so Chromium paints
    // :focus-visible. Two arrows in from the sidebar toggle lands on a
    // measured-row button.
    await step(page, "focus", async () => {
      await page.locator(SEL.toolbar.toggleSidebar).focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await settle(page, 300);
      const focused = await page.evaluate(() =>
        document.activeElement
          ?.closest("[data-toolbar-button-id]")
          ?.getAttribute("data-toolbar-button-id")
      );
      if (!focused) throw new Error("arrow keys did not move focus onto a toolbar button");
      await snapStrip(page, "05-focus-visible");
      await page.keyboard.press("Escape");
      await page.locator("body").click({ position: { x: WIDE.width / 2, y: WIDE.height - 20 } });
    });

    // 6. An armed trigger: the launcher open. The dropdown itself is out of
    // scope; the crop keeps just enough of it to show the anchor relationship.
    await step(page, "armed", async () => {
      await page.locator(BUTTON("launcher")).first().click();
      await page
        .locator('[role="dialog"][aria-label="Launch"]')
        .waitFor({ state: "visible", timeout: 8000 });
      await settle(page, 500);
      await snapStrip(page, "06-armed-launcher", 40);
    });

    // 7-9. Overflow at three widths. Mild evicts the right-side priority-5
    // buttons; severe takes both sides and drops the branch chip; extreme
    // leaves the pill squeezed between two `…` triggers.
    await step(page, "overflow-mild", async () => {
      await page.setViewportSize({ width: 1180, height: 1050 });
      await settle(page, 800);
      await expectOverflow(page, "right");
      await snapStrip(page, "07-overflow-mild");
    });

    await step(page, "overflow-severe", async () => {
      await page.setViewportSize({ width: 820, height: 1050 });
      await settle(page, 800);
      await expectOverflow(page, "right");
      await expectOverflow(page, "left");
      await snapStrip(page, "08-overflow-severe");
    });

    await step(page, "overflow-extreme", async () => {
      await page.setViewportSize({ width: 560, height: 1050 });
      await settle(page, 800);
      await expectOverflow(page, "right");
      await snapStrip(page, "09-overflow-extreme");
    });

    // 10. The right `…` menu open at the severe width, so the trigger's armed
    // state and its badge can be read against the open menu's top edge.
    await step(page, "overflow-menu", async () => {
      await page.setViewportSize({ width: 820, height: 1050 });
      await settle(page, 800);
      await expectOverflow(page, "right");
      await page.locator(OVERFLOW_TRIGGER("right")).click();
      await page.locator('[role="menu"]').first().waitFor({ state: "visible", timeout: 5000 });
      await settle(page, 400);
      await snapStrip(page, "10-overflow-menu-open", 220);
    });

    // 11. Eviction focus redirect. Focus a right-side button by keyboard at
    // full width, shrink until it is evicted, and capture where focus went.
    // The assertion is the point: a capture of focus on <body> would be a
    // capture of the defect, and it would be labelled as the fix.
    await step(page, "eviction", async () => {
      await page.locator(BUTTON("settings")).first().focus();
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowRight");
      const start = await page.evaluate(() =>
        document.activeElement
          ?.closest("[data-toolbar-button-id]")
          ?.getAttribute("data-toolbar-button-id")
      );
      if (start !== "settings") throw new Error(`focus started on ${start}, not settings`);
      await page.setViewportSize({ width: 820, height: 1050 });
      await settle(page, 800);
      await expectOverflow(page, "right");
      const landed = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return "body";
        if (el.matches('[data-toolbar-overflow-trigger][data-toolbar-overflow-side="right"]'))
          return "right-overflow-trigger";
        return el.getAttribute("aria-label") ?? el.tagName;
      });
      // Capture first: a shot of where focus actually went is the evidence,
      // whichever way the assertion falls.
      await snapStrip(page, "11-eviction-focus-redirect");
      if (landed !== "right-overflow-trigger") {
        throw new Error(`after eviction focus landed on "${landed}", not the right … trigger`);
      }
    });

    // 12. Long names at a squeezed width: a long project name and a long
    // branch, so the pill's truncation order and the chip's middle-cut show.
    await step(page, "long-names", async () => {
      const rename = (name: string) =>
        page.evaluate(async (n) => {
          const cur = await window.electron.project.getCurrent();
          if (cur?.id) await window.electron.project.update(cur.id, { name: n });
        }, name);
      await rename(LONG_PROJECT_NAME);
      try {
        // Through the action layer, the way the switch-benchmark fixture does
        // it: a click on the sidebar card selects the row without always
        // switching the active worktree the pill reads.
        await page.locator(SEL.worktree.card(LONG_BRANCH)).first().waitFor({
          state: "visible",
          timeout: T_LONG,
        });
        const selected = await page.evaluate(async (branch) => {
          const w = window as unknown as {
            __DAINTREE_E2E_WORKTREES__?: () => Array<{ id: string; branch: string }>;
            __daintreeDispatchAction?: (
              id: string,
              payload: unknown,
              opts: { source: string }
            ) => Promise<{ ok: boolean; error?: { message: string } }>;
          };
          const target = w.__DAINTREE_E2E_WORKTREES__?.().find((t) => t.branch === branch);
          if (!target || !w.__daintreeDispatchAction) return "no bridge";
          const result = await w.__daintreeDispatchAction(
            "worktree.select",
            { worktreeId: target.id },
            { source: "test" }
          );
          return result.ok ? "ok" : (result.error?.message ?? "failed");
        }, LONG_BRANCH);
        if (selected !== "ok") throw new Error(`worktree.select: ${selected}`);
        // `middleTruncate` spells its ellipsis as three dots.
        let last = "";
        for (let i = 0; i < 40; i++) {
          const pill = await page.locator(SEL.toolbar.projectSwitcherTrigger).textContent();
          if (pill?.includes("...")) break;
          const cards = await page
            .locator("[data-worktree-branch]")
            .evaluateAll((els) => els.map((el) => el.getAttribute("data-worktree-branch")));
          last = `pill="${pill}" cards=${JSON.stringify(cards)}`;
          await page.waitForTimeout(250);
          if (i === 39) throw new Error(`pill never showed the truncated long branch: ${last}`);
        }
        await page.setViewportSize({ width: 1180, height: 1050 });
        await settle(page, 800);
        await snapStrip(page, "12-long-names");
      } finally {
        await page
          .evaluate(async () => {
            const w = window as unknown as {
              __DAINTREE_E2E_WORKTREES__?: () => Array<{ id: string; branch: string }>;
              __daintreeDispatchAction?: (id: string, payload: unknown, o: unknown) => unknown;
            };
            const main = w.__DAINTREE_E2E_WORKTREES__?.().find((t) => t.branch === "main");
            if (main) {
              await w.__daintreeDispatchAction?.(
                "worktree.select",
                { worktreeId: main.id },
                { source: "test" }
              );
            }
          })
          .catch(() => {});
        await rename(PROJECT_NAME);
      }
    });

    // 13-14. The two accessibility media modes, with every signal live.
    // forced-colors strips box-shadow (every ring) and repaints backgrounds;
    // contrast-more swaps in the high-contrast block. A pip that only exists
    // as a coloured fill disappears in both.
    await step(page, "forced-colors", async () => {
      await page.emulateMedia({ forcedColors: "active" });
      await settle(page, 500);
      await snapStrip(page, "13-forced-colors");
    });

    await step(page, "contrast-more", async () => {
      await page.emulateMedia({ contrast: "more" });
      await settle(page, 500);
      await snapStrip(page, "14-contrast-more");
    });

    // 15-16. The re-shuffled composition. A reload drops the in-memory
    // signals, so the errors and unread are re-seeded; the agent panel is left
    // to session restore, and the capture is honest either way.
    await step(page, "composition-alt", async () => {
      await seedComposition(page, ALT_LEFT, ALT_RIGHT);
      await seedSignals(page);
      await expect(page.locator(BUTTON("settings")).first()).toBeVisible({ timeout: 10_000 });
      // No fit assertion: with an agent and four panel buttons moved right,
      // this composition earns two dividers and may overflow even at 1680px.
      // Whether it does is part of what the capture is for.
      await snapStrip(page, "15-composition-alt");
    });

    await step(page, "composition-alt-overflow", async () => {
      await page.setViewportSize({ width: 900, height: 1050 });
      await settle(page, 800);
      await expectOverflow(page, "right");
      await snapStrip(page, "16-composition-alt-overflow");
    });

    // 17-18. Platform variants. `isMac`/`isWindows`/`isLinux` read
    // navigator.platform and userAgent, which CDP can override for the page;
    // the native window chrome stays macOS, so only the strip's own spacers
    // and app-menu button are under review here.
    await step(page, "platform-windows", async () => {
      await overridePlatform(page, "Win32");
      await seedSignals(page);
      await expect(page.locator('[aria-label="Application menu"], [data-app-menu-button]').first())
        .toBeVisible({ timeout: 8000 })
        .catch(() => {});
      await snapStrip(page, "17-platform-windows");
    });

    await step(page, "platform-linux", async () => {
      await overridePlatform(page, "Linux x86_64");
      await seedSignals(page);
      await snapStrip(page, "18-platform-linux");
    });

    await overridePlatform(page, "MacIntel").catch(() => {});

    // 19. macOS fullscreen: the traffic-light spacer collapses to w-0. Last,
    // because entering fullscreen resizes the window under everything else.
    await step(page, "fullscreen", async () => {
      await seedSignals(page);
      await ctx!.app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setFullScreen(true);
      });
      await expect(page.locator('[data-fullscreen="true"]').first()).toBeAttached({
        timeout: 8000,
      });
      await settle(page, 1500);
      await snapStrip(page, "19-fullscreen-mac");
      await ctx!.app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setFullScreen(false);
      });
      await settle(page, 1500);
    });

    // Count what landed against what was promised. The exit code says only
    // that no step threw; this says the sweep actually produced its artifacts.
    const expected = STEPS.filter((s) => ONLY.length === 0 || ONLY.includes(s.name)).map(
      (s) => `${s.slug}${TAG}.png`
    );
    const present = new Set(readdirSync(OUTPUT_DIR));
    const missing = expected.filter((f) => !present.has(f));

    expect(stepFailures, `toolbar capture steps failed in "${THEME}"`).toEqual([]);
    expect(missing, `toolbar captures missing in "${THEME}"`).toEqual([]);
  } finally {
    if (ctx) await closeApp(ctx.app);
    repo.cleanup();
  }
});
