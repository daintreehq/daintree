/**
 * Motion and reduced-motion capture harness.
 *
 * Motion cannot be judged from a resting frame, so every step here triggers a
 * surface, waits for the transitions and keyframes it starts, pauses them all
 * through the Web Animations API and seeks them to the same fraction of their
 * run before the PNG is written. The frame shows where the surface is part way
 * through entering: how far it has risen or scaled, how far it has faded in.
 *
 * The whole sequence runs twice, first with motion on and then with the in-app
 * "Reduce UI animations" setting on, set through its real action
 * (`preferences.reduceAnimations.set`). The reduced frames are the evidence for
 * the policy: a surface should still be part way through its fade, with no
 * rise, zoom or slide.
 *
 * Next to the PNGs it writes `motion-audit.json`, one record per step and pass
 * listing every animation the trigger started (property or keyframe, duration,
 * delay, easing, target). A step whose trigger started nothing is recorded as
 * such, which is itself a finding for a surface that should animate.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_MOTION is set.
 *
 *   DAINTREE_SHOT_MOTION=1 DESIGN_CAPTURE_DIR=/tmp/shots \
 *     npx playwright test --project=screenshots motion-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_MOTION        required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR          output directory (default artifacts/motion-shots)
 *   DAINTREE_SHOT_ONLY          comma-separated step filter
 *   DAINTREE_SHOT_FRACTION      how far into each animation to freeze (default 0.1;
 *                               the spring-critical entry curve is ~96% settled by 0.3)
 *   DAINTREE_SCREENSHOT_SCALE   device scale factor (default 1)
 *
 * Output: <dir>/<NN-slug>--<full|reduced>.png plus motion-audit.json.
 */

import { expect, test, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { injectToast, resetNotifications } from "../helpers/notifications";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_MOTION;
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "1";
const FRACTION = Number(process.env.DAINTREE_SHOT_FRACTION ?? "0.1");
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : path.resolve(process.cwd(), "artifacts", "motion-shots");
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MOD = process.platform === "darwin" ? "Meta" : "Control";

type Pass = "full" | "reduced";

interface AnimRecord {
  kind: string;
  name: string;
  duration: number;
  delay: number;
  easing: string;
  target: string;
}

interface AuditRecord {
  step: string;
  pass: Pass;
  animations: AnimRecord[];
}

const audit: AuditRecord[] = [];
const failures: string[] = [];
let expected = 0;

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-motion-"));
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(path.join(dir, "src", "index.ts"), "export const main = () => 0;\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function settle(page: Page, ms = 300): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function timelineNow(page: Page): Promise<number> {
  return page.evaluate(() => Number(document.timeline.currentTime ?? 0));
}

/**
 * Waits for the animations started at or after `t0`, pauses every one of them
 * and seeks each to `fraction` of its active duration. Returns what it froze.
 */
async function freeze(page: Page, t0: number, fraction: number): Promise<AnimRecord[]> {
  return page.evaluate(
    async ({ t0, fraction }) => {
      const describe = (el: Element | null | undefined): string => {
        if (!el) return "";
        const id = el.id ? `#${el.id}` : "";
        const label = el.getAttribute("aria-label");
        const role = el.getAttribute("role");
        const cls = (el.getAttribute("class") ?? "").split(/\s+/).slice(0, 4).join(".");
        return `${el.tagName.toLowerCase()}${id}${role ? `[role=${role}]` : ""}${label ? `[aria-label=${label}]` : ""}${cls ? `.${cls}` : ""}`;
      };
      const started = (): Animation[] =>
        document.getAnimations().filter((a) => {
          const timing = a.effect?.getComputedTiming();
          if (!timing || timing.iterations === Infinity) return false;
          return a.startTime === null || Number(a.startTime) >= t0 - 1;
        });
      const deadline = performance.now() + 700;
      let picked: Animation[];
      let lastCount = -1;
      for (;;) {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        picked = started();
        // Two frames with the same non-zero count: every transition the
        // trigger's style flip creates has been created.
        if (picked.length > 0 && picked.length === lastCount) break;
        lastCount = picked.length;
        if (performance.now() > deadline) break;
      }
      const records = [];
      for (const a of picked) {
        a.pause();
        const timing = a.effect!.getComputedTiming();
        const duration = Number(timing.duration) || 0;
        const delay = Number(timing.delay) || 0;
        a.currentTime = delay + duration * fraction;
        const effect = a.effect as KeyframeEffect;
        const name =
          (a as unknown as { transitionProperty?: string }).transitionProperty ??
          (a as unknown as { animationName?: string }).animationName ??
          "";
        records.push({
          kind: a.constructor.name,
          name,
          duration,
          delay,
          easing: String(effect.getComputedTiming().easing ?? ""),
          target: describe(effect.target as Element | null),
        });
      }
      return records;
    },
    { t0, fraction }
  );
}

async function release(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      for (const a of document.getAnimations()) {
        if (a.playState === "paused") a.play();
      }
    })
    .catch(() => {});
}

async function snap(page: Page, slug: string, pass: Pass): Promise<void> {
  const file = path.join(OUTPUT_DIR, `${slug}--${pass}.png`);
  await page.screenshot({ path: file, type: "png", animations: "allow", caret: "hide" });
}

async function closeOverlays(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 120);
  }
}

async function dispatch(page: Page, id: string, args?: unknown): Promise<void> {
  await page.evaluate(
    async ({ id, args }) => {
      const run = (
        window as unknown as {
          __daintreeDispatchAction?: (i: string, a: unknown, o: unknown) => Promise<unknown>;
        }
      ).__daintreeDispatchAction;
      if (typeof run !== "function") throw new Error("Action dispatch hook not available");
      await run(id, args, { source: "user" });
    },
    { id, args }
  );
}

/**
 * One captured state: `trigger` starts the motion, `ready` (optional) proves
 * the surface is the one we meant, `reset` puts the app back.
 */
async function capture(
  page: Page,
  pass: Pass,
  slug: string,
  trigger: () => Promise<void>,
  ready: (() => Promise<void>) | null,
  reset: () => Promise<void>
): Promise<void> {
  const name = slug.replace(/^\d+-/, "");
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  expected += 1;
  try {
    // Park the pointer on neutral canvas so no hover state rides into a frame.
    await page.mouse.move(700, 720);
    await settle(page, 200);
    const t0 = await timelineNow(page);
    await trigger();
    const animations = await freeze(page, t0, FRACTION);
    if (ready) await ready();
    await snap(page, slug, pass);
    audit.push({ step: slug, pass, animations });
  } catch (error) {
    const detail = String(error).split("\n")[0];
    console.warn(`[motion-shots] ${slug} (${pass}) FAILED:`, detail);
    failures.push(`${slug} (${pass}): ${detail}`);
  } finally {
    await release(page);
    await settle(page, 250);
    await reset().catch(() => {});
    await closeOverlays(page);
    await settle(page, 250);
  }
}

async function runPass(page: Page, pass: Pass): Promise<void> {
  const noop = async () => {};

  await capture(
    page,
    pass,
    "01-dialog-enter",
    () => dispatch(page, "worktree.createDialog.open"),
    () => expect(page.locator('[role="dialog"][aria-modal="true"]').last()).toBeAttached(),
    noop
  );

  await capture(
    page,
    pass,
    "02-palette-enter",
    () => page.keyboard.press(`${MOD}+Shift+P`),
    () => expect(page.locator(SEL.actionPalette.dialog)).toBeAttached(),
    noop
  );

  await capture(
    page,
    pass,
    "03-context-menu-enter",
    () => page.locator(SEL.worktree.mainCard).first().click({ button: "right" }),
    () => expect(page.locator('[role="menu"]').first()).toBeAttached(),
    noop
  );

  await capture(
    page,
    pass,
    "04-fixed-dropdown-enter",
    () => page.locator(SEL.notifications.bellButton).first().click(),
    null,
    noop
  );

  await capture(
    page,
    pass,
    "05-toast-enter",
    async () => {
      await injectToast(page, {
        type: "error",
        title: "Push failed",
        message:
          "The remote rejected feature/checkout-redesign because it has commits you don't have.",
        duration: 0,
      });
    },
    () => expect(page.locator(SEL.notifications.toastRegion)).toBeAttached(),
    () => resetNotifications(page)
  );

  await capture(
    page,
    pass,
    "06-theme-browser-enter",
    () => dispatch(page, "app.theme.browser.open"),
    null,
    noop
  );

  await capture(
    page,
    pass,
    "07-sidebar-hide",
    () => dispatch(page, "nav.toggleSidebar"),
    null,
    () => dispatch(page, "nav.toggleSidebar")
  );

  await capture(
    page,
    pass,
    "08-help-panel-open",
    () => dispatch(page, "help.togglePanel"),
    null,
    () => dispatch(page, "help.togglePanel")
  );
}

test("motion — surfaces mid-flight, full and reduced motion", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_MOTION is required for the motion capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_MOTION to run the motion capture");
  test.setTimeout(600_000);

  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-motion-ud-"));
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1440, height: 900 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await dismissBlockingPalette(page);
    await page
      .locator(SEL.worktree.mainCard)
      .waitFor({ state: "visible", timeout: T_LONG })
      .catch(() => {});
    await settle(page, 2000);
    await dismissBlockingPalette(page);

    // Load the lazy Theme browser chunk once, so its captured entrance is the
    // sheet moving rather than an empty wrapper waiting on Suspense.
    await dispatch(page, "app.theme.browser.open");
    await settle(page, 1500);
    await closeOverlays(page);
    await settle(page, 500);

    await runPass(page, "full");

    await dispatch(page, "preferences.reduceAnimations.set", { value: true });
    await expect
      .poll(() => page.evaluate(() => document.body.dataset.reduceAnimations ?? ""))
      .toBe("true");
    await settle(page, 500);

    await runPass(page, "reduced");

    await dispatch(page, "preferences.reduceAnimations.set", { value: false }).catch(() => {});
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    if (existsSync(userDataDir)) rmSync(userDataDir, { recursive: true, force: true });
  }

  writeFileSync(path.join(OUTPUT_DIR, "motion-audit.json"), JSON.stringify(audit, null, 2));
  const written = readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")).length;
  if (failures.length > 0) throw new Error(`motion capture failures:\n${failures.join("\n")}`);
  if (written !== expected) throw new Error(`expected ${expected} PNGs, wrote ${written}`);
});
