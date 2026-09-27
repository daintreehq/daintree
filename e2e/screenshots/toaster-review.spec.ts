/**
 * Toaster visual-review harness.
 *
 * The toast stack is the top-right pile of up to three cards the app raises for
 * events the user could not otherwise observe: a failed push, an agent that
 * finished, a coalesced burst of the same error. Each card carries a severity
 * icon, title, message, up to two actions, an options menu (silence/mute), a
 * dismiss button and, for coalesced bursts, a count badge; the "+N more" pill
 * under the stack links to the notification center. Fixtures go through the
 * E2E notification backdoor (`src/lib/e2eNotificationBackdoor.ts`), which
 * writes the store the toaster subscribes to, and use long real-world copy so
 * wrapping and truncation defects show.
 *
 * Every shot is the toast region plus a margin of the app behind it. Each state
 * is verified painted — the seeded text is on screen and the newest card has
 * finished entering — before its PNG is written; a wrong artifact throws.
 *
 * Steps (each also the DAINTREE_SHOT_ONLY filter name):
 *
 *   single     one card per shape: titled, untitled, one action, two actions, count
 *   stack      three live cards plus the "+N more" pill
 *   focus      keyboard focus on primary action, secondary, options, dismiss, pill
 *   hover      pointer over the card (reveals options), primary, dismiss
 *   menu       the options menu open
 *   success    an action's success confirmation
 *   contrast   `prefers-contrast: more`
 *   forced     `forced-colors: active`
 *   themes     the stack across four palettes
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_TOASTER is set.
 *
 *   DAINTREE_SHOT_TOASTER=1 npx playwright test --project=screenshots toaster-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_TOASTER  required — any truthy value runs the capture
 *   DAINTREE_SHOT_ONLY     comma-separated step filter (see step names above)
 *   DESIGN_CAPTURE_DIR     optional output dir, so review rounds write outside the tree
 *
 * Output: artifacts/toaster-shots/<NN-slug>.png (gitignored).
 */

import { test, type CDPSession, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { openTerminal } from "../helpers/panels";
import {
  injectToast,
  resetNotifications,
  setEvictedToInboxCount,
  type InjectToastOptions,
} from "../helpers/notifications";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_TOASTER;
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : path.resolve(process.cwd(), "artifacts", "toaster-shots");

const REGION = SEL.notifications.toastRegion;

const POLISH_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

type Fixture = InjectToastOptions & { expect: string };

const CONTEXT = { projectId: "e2e-project", eventKind: "git" };

const PUSH_FAILED: Fixture = {
  type: "error",
  title: "Push failed",
  message:
    "The remote rejected feature/checkout-redesign because it has commits you don't have. Pull first, then push again.",
  actions: [{ label: "Pull and rebase", variant: "primary" }],
  context: CONTEXT,
  expect: "The remote rejected",
};
const AGENT_DONE: Fixture = {
  type: "success",
  title: "Claude finished",
  message: "Refactored the checkout form in helios-dashboard/feature-checkout.",
  actions: [
    { label: "Open review", variant: "primary" },
    { label: "Show terminal", variant: "secondary" },
  ],
  context: { projectId: "e2e-project", eventKind: "completed" },
  expect: "Refactored the checkout form",
};
const DISK: Fixture = {
  type: "warning",
  title: "Worktree setup is taking longer than expected on a slow network drive",
  message: "npm install has been running for 3 minutes.",
  count: 4,
  context: { projectId: "e2e-project", eventKind: "host" },
  expect: "npm install has been running",
};
const COPIED: Fixture = {
  type: "info",
  message: "Terminal output copied to the clipboard.",
  count: 3,
  expect: "Terminal output copied",
};
const SAVED: Fixture = {
  type: "success",
  title: "Token saved",
  message: "GitHub requests now use your personal access token.",
  expect: "GitHub requests now use",
};
const PLAIN: Fixture = {
  type: "info",
  title: "Update available",
  message: "Daintree 0.42.0 is downloading in the background.",
  expect: "is downloading in the background",
};
const SUCCESS_FLOW: Fixture = {
  type: "info",
  title: "Branch name copied",
  message: "feature/checkout-redesign",
  actionLabel: "Copy path",
  successLabel: "Copied",
  expect: "feature/checkout-redesign",
};

const failures: string[] = [];

async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).slice(0, 300);
    console.warn(`[toaster-shots] step "${name}" failed:`, detail);
    failures.push(`${name}: ${detail}`);
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
    await resetMedia(page).catch(() => {});
    await page.mouse.move(400, 700).catch(() => {});
  }
}

let mediaSession: CDPSession | null = null;

async function setMediaFeatures(
  page: Page,
  features: { name: string; value: string }[]
): Promise<void> {
  mediaSession ??= await page.context().newCDPSession(page);
  await mediaSession.send("Emulation.setEmulatedMedia", { features });
  for (const f of features) {
    const query = `(${f.name}: ${f.value})`;
    const matches = await page.evaluate((q) => window.matchMedia(q).matches, query);
    if (!matches) throw new Error(`media emulation did not apply: ${query}`);
  }
}

async function resetMedia(page: Page): Promise<void> {
  if (mediaSession) {
    await mediaSession.send("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
  }
  await page.emulateMedia({ forcedColors: null }).catch(() => {});
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/** Clear every toast, then inject the fixtures oldest-first and wait for each to paint. */
async function show(page: Page, fixtures: Fixture[], overflow = 0): Promise<void> {
  await resetNotifications(page);
  await page
    .locator(REGION)
    .waitFor({ state: "detached", timeout: 3000 })
    .catch(() => {});
  await settle(page, 200);
  for (const fixture of fixtures) {
    const { expect: _text, ...opts } = fixture;
    await injectToast(page, { ...opts, duration: 0 });
    await settle(page, 80);
  }
  if (overflow > 0) await setEvictedToInboxCount(page, overflow);
  for (const fixture of fixtures) {
    await page.locator(REGION).getByText(fixture.expect).first().waitFor({ timeout: 8000 });
  }
  await page.waitForFunction(
    ({ sel, n }) => {
      const region = document.querySelector<HTMLElement>(sel);
      if (!region) return false;
      const cards = Array.from(region.querySelectorAll<HTMLElement>(":scope > [role]"));
      return cards.length === n && cards.every((c) => getComputedStyle(c).opacity === "1");
    },
    { sel: REGION, n: fixtures.length },
    { timeout: 5000 }
  );
  if (overflow > 0) {
    await page.locator(SEL.notifications.toastOverflowPill).waitFor({ timeout: 3000 });
  }
  await settle(page, 300);
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

/** Hover shots go through the CDP session that forced `(hover: hover)`; Playwright's own path drops it. */
async function snapViaCdp(page: Page, slug: string, below = 40): Promise<void> {
  await settle(page);
  mediaSession ??= await page.context().newCDPSession(page);
  const clip = await regionClip(page, below);
  const { data } = await mediaSession.send("Page.captureScreenshot", {
    format: "png",
    clip: { ...clip, scale: 1 },
  });
  writeFileSync(path.join(OUTPUT_DIR, `${slug}.png`), Buffer.from(data, "base64"));
}

async function snapWindow(page: Page, slug: string): Promise<void> {
  await settle(page);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${slug}.png`),
    type: "png",
    animations: "disabled",
    caret: "hide",
  });
}

async function ensureHoverMedia(page: Page): Promise<void> {
  if (!(await page.evaluate(() => matchMedia("(hover: hover)").matches))) {
    await setMediaFeatures(page, [{ name: "hover", value: "hover" }]);
  }
}

/** Keyboard-focus a control so Chromium paints `:focus-visible`, and throw if it didn't. */
async function keyboardFocus(page: Page, name: string | RegExp): Promise<void> {
  const button = page.locator(REGION).getByRole("button", { name }).first();
  await button.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  const ok = await button.evaluate((el) => el.matches(":focus-visible"));
  if (!ok) throw new Error(`focus: "${String(name)}" is not :focus-visible`);
}

const geometry: Record<string, unknown> = {};

async function measure(page: Page, label: string): Promise<void> {
  geometry[label] = await page.evaluate((sel) => {
    const region = document.querySelector<HTMLElement>(sel);
    if (!region) return null;
    return Array.from(region.querySelectorAll<HTMLElement>("button")).map((b) => {
      const r = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      return {
        name: b.getAttribute("aria-label") ?? b.textContent?.trim(),
        w: Math.round(r.width),
        h: Math.round(r.height),
        color: cs.color,
        bg: cs.backgroundColor,
        opacity: cs.opacity,
      };
    });
  }, REGION);
}

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-toaster-shots-"));
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
const STACK: Fixture[] = [PLAIN, DISK, PUSH_FAILED];

test("toaster review — cards, stack, focus, menu, themes", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_TOASTER is required for the toaster capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_TOASTER to run the toaster capture");
  test.setTimeout(10 * 60_000);

  failures.length = 0;
  mediaSession = null;
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-toastershot-"));
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await prepareGrid(page);

    await step(page, "single", async () => {
      const set: [string, Fixture][] = [
        ["01-error-one-action", PUSH_FAILED],
        ["02-success-two-actions", AGENT_DONE],
        ["03-warning-long-title-count", DISK],
        ["04-info-untitled-count", COPIED],
        ["05-success-plain", SAVED],
      ];
      for (const [slug, fixture] of set) {
        await show(page, [fixture]);
        await measure(page, slug);
        await snap(page, slug);
      }
    });

    await step(page, "stack", async () => {
      await show(page, STACK, 4);
      await measure(page, "10-stack");
      await snap(page, "10-stack-three-plus-overflow", 60);
      await snapWindow(page, "11-window-stack");
    });

    await step(page, "focus", async () => {
      await show(page, [AGENT_DONE]);
      await keyboardFocus(page, "Open review");
      await snap(page, "20-focus-primary-action");
      await keyboardFocus(page, "Show terminal");
      await snap(page, "21-focus-secondary-action");
      await keyboardFocus(page, "Notification options");
      await snap(page, "22-focus-options");
      await keyboardFocus(page, "Dismiss notification");
      await snap(page, "23-focus-dismiss");
      await show(page, [PLAIN], 4);
      await keyboardFocus(page, /more in notification center/);
      await snap(page, "24-focus-overflow-pill", 40);
    });

    await step(page, "hover", async () => {
      await ensureHoverMedia(page);
      await show(page, [AGENT_DONE]);
      await page.locator(REGION).getByText(AGENT_DONE.expect).hover();
      await snapViaCdp(page, "30-hover-card");
      await page.locator(REGION).getByRole("button", { name: "Open review" }).hover();
      await snapViaCdp(page, "31-hover-primary-action");
      await page.locator(REGION).getByRole("button", { name: "Dismiss notification" }).hover();
      await snapViaCdp(page, "32-hover-dismiss");
    });

    await step(page, "menu", async () => {
      await show(page, [PUSH_FAILED]);
      await page.locator(REGION).getByRole("button", { name: "Notification options" }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menu").waitFor({ state: "visible", timeout: 3000 });
      await snap(page, "40-options-menu-open", 120);
    });

    await step(page, "success", async () => {
      await show(page, [SUCCESS_FLOW]);
      await page.locator(REGION).getByRole("button", { name: "Copy path" }).click();
      await page.locator(SEL.notifications.toastActionCheckmark).waitFor({ timeout: 3000 });
      await snap(page, "50-action-success");
    });

    await step(page, "contrast", async () => {
      await setMediaFeatures(page, [{ name: "prefers-contrast", value: "more" }]);
      await show(page, STACK, 4);
      await snap(page, "90-high-contrast-stack", 60);
    });

    await step(page, "forced", async () => {
      await page.emulateMedia({ forcedColors: "active" });
      await settle(page, 400);
      if (!(await page.evaluate(() => matchMedia("(forced-colors: active)").matches))) {
        throw new Error("forced-colors emulation did not apply");
      }
      await show(page, [AGENT_DONE]);
      await snap(page, "92-forced-colors-two-actions");
      await show(page, STACK, 4);
      await snap(page, "93-forced-colors-stack", 60);
    });

    await step(page, "themes", async () => {
      for (const [i, theme] of SPOT_THEMES.entries()) {
        await setAppTheme(page, theme);
        await prepareGrid(page);
        await show(page, [AGENT_DONE, DISK, PUSH_FAILED], 2);
        await measure(page, `95-theme-${theme}`);
        await snap(page, `95-theme-${i}-${theme}-stack`, 60);
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

  if (Object.keys(geometry).length > 0) {
    writeFileSync(
      path.join(OUTPUT_DIR, "geometry.json"),
      JSON.stringify(geometry, null, 2),
      "utf8"
    );
  }

  const written = existsSync(OUTPUT_DIR)
    ? readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")).length
    : 0;
  console.warn(`[toaster-shots] wrote ${written} png(s) to ${OUTPUT_DIR}`);

  if (failures.length > 0) {
    throw new Error(`[toaster-shots] ${failures.length} step(s) failed:\n${failures.join("\n")}`);
  }
  if (written === 0) {
    throw new Error(`[toaster-shots] no PNGs written to ${OUTPUT_DIR}`);
  }
});
