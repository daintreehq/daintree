/**
 * Main toolbar press-and-reveal visual-review harness.
 *
 * Drives `toolbar-preview.html` (the real `Toolbar` on seeded stores) and asks
 * one question of every control on the strip: does it answer a press, and open
 * its surface, in the same language as its neighbours?
 *
 * Two kinds of evidence:
 * - Stills of each sampled control at rest, hovered, held down and open,
 *   cropped tight so a press is visible at all.
 * - `press-metrics-<theme>.json`: for every visible toolbar button, its box at
 *   rest and while held, the pixel shrink between them, and the computed
 *   transition, scale, transform and fill that won. A press effect that scales
 *   with the control's width shows up here as different shrinks, which no
 *   still can prove.
 * - Reveal filmstrips: the animation clock is frozen through CDP before the
 *   trigger is pressed, then every running animation is seeked to fixed
 *   offsets, so the frames are exact rather than raced. The timings of every
 *   animation that ran land in `reveal-<name>-<theme>.json`.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_TOOLBARPRESS is set.
 *
 *   DAINTREE_SHOT_TOOLBARPRESS=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots toolbar-press-reveal-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_TOOLBARPRESS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR           required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES        themes to sweep (default daintree,bondi)
 *
 * Never writes a PNG it has not verified, and counts the files itself at the end.
 */

import { test, expect, type Page, type Locator } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_TOOLBARPRESS;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

test.use({ deviceScaleFactor: 2 });

const STRIP = '[role="toolbar"][aria-label="Main toolbar"]';
const PILL = '[data-testid="project-switcher-trigger"]';
const HOLD_MS = 260;
const FRAMES = [0, 40, 80, 120, 160, 200, 320];

const NO_SCROLLBAR_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  * { caret-color: transparent !important; }
`;

let server: PreviewServer | undefined;
const consoleErrors: string[] = [];
const expected: string[] = [];

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!path.isAbsolute(OUT_DIR)) {
    throw new Error("DAINTREE_SHOT_DIR must be an absolute directory outside the repo");
  }
  const repoRoot = realpathSync(process.cwd());
  mkdirSync(OUT_DIR, { recursive: true });
  const outReal = realpathSync(OUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DAINTREE_SHOT_DIR must be outside the repo (${OUT_DIR})`);
  }
  for (const file of readdirSync(OUT_DIR)) {
    if (file.endsWith(".png") || file.endsWith(".json")) rmSync(path.join(OUT_DIR, file));
  }
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

interface OpenOptions {
  theme: string;
  name?: string;
  branch?: string;
}

async function openToolbar(page: Page, opts: OpenOptions): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 520 });
  const q = new URLSearchParams({ theme: opts.theme, fixture: "owner", platform: "mac" });
  if (opts.name) q.set("name", opts.name);
  if (opts.branch) q.set("branch", opts.branch);
  const url = `${server!.baseURL}/toolbar-preview.html?${q.toString()}`;
  await page.goto(url, { waitUntil: "load" });
  await page.addStyleTag({ content: NO_SCROLLBAR_CSS });
  await page
    .locator(STRIP)
    .waitFor({ state: "visible", timeout: 30_000 })
    .catch((e: unknown) => {
      throw new Error(`toolbar never mounted (${url}): ${String(e)}\n${consoleErrors.join("\n")}`);
    });
  await page
    .locator('[data-toolbar-button-id="launcher"] button')
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await page.locator(PILL).waitFor({ state: "visible", timeout: 15_000 });
  await settle(page);
}

/**
 * Vite's dependency optimizer discovers the lazily loaded overlays' deps on
 * first open, re-bundles, and invalidates the page: the next capture lands on
 * a blank document. Open every surface this harness touches once, let the
 * optimizer finish, and only then start capturing on a fresh load.
 */
async function warmUp(page: Page, theme: string): Promise<void> {
  for (let pass = 0; pass < 2; pass++) {
    await openToolbar(page, { theme });
    for (const sel of [
      PILL,
      '[data-toolbar-button-id="claude"] button >> nth=-1',
      '[data-toolbar-button-id="launcher"] button >> nth=0',
      ".toolbar-stat-pill >> nth=0",
    ]) {
      const el = page.locator(sel);
      if (!(await el.isVisible().catch(() => false))) continue;
      await el.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(1_500);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
    }
    await page.waitForTimeout(2_000);
  }
}

async function settle(page: Page, ms = 300): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function rest(page: Page): Promise<void> {
  if (
    !(await page
      .locator(STRIP)
      .isVisible()
      .catch(() => false))
  ) {
    throw new Error(`toolbar unmounted mid-capture\n${consoleErrors.join("\n")}`);
  }
  await page.mouse.up().catch(() => {});
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  // Escape is a key, so the trigger it restores focus to then matches
  // :focus-visible and its ring would sit in the next control's rest frame.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(700, 480);
  await settle(page, 350);
}

/**
 * A tight crop around a control: the control plus 14px of strip on every side.
 * Pass `fixed` (the control's box at rest) when the control may have changed
 * size, so a press that shrinks it shows as a shrink rather than a re-crop.
 */
async function snapControl(
  page: Page,
  target: Locator,
  file: string,
  fixed?: { x: number; y: number; width: number; height: number }
): Promise<void> {
  expected.push(file);
  const box =
    fixed ??
    (await target.boundingBox({ timeout: 10_000 }).catch(async (e: unknown) => {
      await page.screenshot({ path: path.join(OUT_DIR, `debug-${file}`) });
      throw new Error(`${file}: control never resolved: ${String(e)}`);
    }));
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: control has no real box (${JSON.stringify(box)})`);
  }
  const pad = 14;
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    clip: {
      x: Math.max(0, box.x - pad),
      y: 0,
      width: box.width + pad * 2,
      height: box.y + box.height + pad,
    },
  });
  if (!existsSync(out)) throw new Error(`${file}: screenshot did not land`);
}

/** Every visible strip button's rest box, held box, and the computed styles that won. */
async function pressMetrics(page: Page) {
  const handles = await page.locator(`${STRIP} button:visible`).elementHandles();
  const rows: unknown[] = [];
  for (const handle of handles) {
    const info = await handle.evaluate((node) => {
      const el = node as HTMLElement;
      const r = el.getBoundingClientRect();
      const toolbarId = el
        .closest("[data-toolbar-button-id]")
        ?.getAttribute("data-toolbar-button-id");
      return {
        label: el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 24) ?? "",
        id: toolbarId ?? null,
        cls: Array.from(el.classList)
          .filter((c) => c.startsWith("toolbar-"))
          .join(" "),
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
        hidden: !!el.closest('[aria-hidden="true"]'),
      };
    });
    if (info.hidden || info.w < 8) continue;
    const read = () =>
      handle.evaluate((node) => {
        const el = node as HTMLElement;
        const cs = getComputedStyle(el);
        const before = getComputedStyle(el, "::before");
        const r = el.getBoundingClientRect();
        return {
          w: r.width,
          h: r.height,
          scale: cs.scale,
          transform: cs.transform,
          background: cs.backgroundColor,
          beforeOpacity: before.content === "none" ? null : before.opacity,
          beforeBg: before.content === "none" ? null : before.backgroundColor,
          transitionProperty: cs.transitionProperty,
          transitionDuration: cs.transitionDuration,
          transitionTimingFunction: cs.transitionTimingFunction,
        };
      });
    await page.mouse.move(info.x + info.w / 2, info.y + info.h / 2);
    await settle(page, 220);
    const hovered = await read();
    await page.mouse.down();
    // One frame in: what the press looks like on the first painted frame.
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    const firstFrame = await read();
    await page.waitForTimeout(HOLD_MS);
    const held = await read();
    await page.mouse.up();
    // Released but still hovered: what the release eases through.
    const released = await read();
    rows.push({
      ...info,
      hovered,
      firstFrame,
      held,
      released,
      shrinkPx: { w: +(info.w - held.w).toFixed(2), h: +(info.h - held.h).toFixed(2) },
      shrinkPerEdgePx: +((info.w - held.w) / 2).toFixed(2),
    });
    await rest(page);
  }
  return rows;
}

/** Freeze the document timeline, open a surface, and film it at fixed offsets. */
async function filmReveal(
  page: Page,
  name: string,
  theme: string,
  trigger: Locator,
  surface: string,
  open: (t: Locator) => Promise<void>
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
  try {
    await open(trigger);
    await page.locator(surface).first().waitFor({ state: "attached", timeout: 10_000 });
    await page.evaluate(() => new Promise<void>((r) => setTimeout(r, 60)));
    const timings = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
        .map((a) => {
          const effect = a.effect as KeyframeEffect | null;
          const target = effect?.target as Element | null;
          const timing = effect?.getComputedTiming();
          return {
            kind: a.constructor.name,
            name:
              (a as unknown as { animationName?: string }).animationName ??
              (a as unknown as { transitionProperty?: string }).transitionProperty ??
              null,
            target: target
              ? `${target.tagName.toLowerCase()}${target.getAttribute("role") ? `[role=${target.getAttribute("role")}]` : ""}${target.getAttribute("data-testid") ? `[data-testid=${target.getAttribute("data-testid")}]` : ""}.${String(target.className).split(" ").slice(0, 3).join(".")}`
              : null,
            duration: timing?.duration ?? null,
            delay: timing?.delay ?? null,
            easing: timing?.easing ?? null,
          };
        })
    );
    writeFileSync(
      path.join(OUT_DIR, `reveal-${name}-${theme}.json`),
      JSON.stringify(timings, null, 2)
    );
    const seek = async (ms: number) => {
      await page.evaluate((at) => {
        for (const a of document.getAnimations()) {
          a.pause();
          a.currentTime = at;
        }
      }, ms);
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    };
    // One crop for every frame, measured on the settled surface, so the frames
    // line up and a scale or slide reads as motion rather than as re-cropping.
    await seek(FRAMES[FRAMES.length - 1]!);
    const tBox = await trigger.boundingBox();
    const sBox = await page.locator(surface).first().boundingBox();
    if (!tBox || !sBox) throw new Error(`reveal-${name}-${theme}: trigger or surface has no box`);
    const x0 = Math.max(0, Math.min(tBox.x, sBox.x) - 16);
    const x1 = Math.min(1440, Math.max(tBox.x + tBox.width, sBox.x + sBox.width) + 16);
    const y1 = Math.min(520, Math.max(tBox.y + tBox.height, sBox.y + sBox.height) + 16);
    for (const t of FRAMES) {
      await seek(t);
      const file = `reveal-${name}-${theme}-t${String(t).padStart(3, "0")}.png`;
      expected.push(file);
      const out = path.join(OUT_DIR, file);
      await page.screenshot({ path: out, clip: { x: x0, y: 0, width: x1 - x0, height: y1 } });
      if (!existsSync(out)) throw new Error(`${file}: screenshot did not land`);
    }
  } finally {
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
    await page.evaluate(() => {
      for (const a of document.getAnimations()) {
        // Ambient loops (the waiting pip) have no end to finish to.
        if (a.effect?.getComputedTiming().endTime !== Infinity) a.finish();
        else a.play();
      }
    });
    await cdp.detach();
    await rest(page);
  }
}

test.describe("toolbar press and reveal review", () => {
  test("captures", async ({ page }) => {
    test.info().annotations.push({
      type: "conditional-skip",
      description: "DAINTREE_SHOT_TOOLBARPRESS is required for the toolbar press capture",
    });
    test.skip(!ENABLED, "Set DAINTREE_SHOT_TOOLBARPRESS to run the toolbar press capture");
    test.setTimeout(900_000);
    await stubViteHmrClient(page);
    const errors: string[] = [];
    page.on("pageerror", (e) => {
      errors.push(String(e));
      consoleErrors.push(e.stack ?? String(e));
    });
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("response", (r) => {
      if (r.status() >= 500) consoleErrors.push(`${r.status()} ${r.url()}`);
    });

    await warmUp(page, THEMES[0]!);

    for (const theme of THEMES) {
      await openToolbar(page, { theme });

      const pill = page.locator(PILL);
      const launcher = page.locator('[data-toolbar-button-id="launcher"] button').first();
      const claude = page.locator('[data-toolbar-button-id="claude"]');
      const claudeMain = claude.locator("button").first();
      const claudeChevron = claude.locator("button").last();
      const codex = page.locator('[data-toolbar-button-id="codex"] button').first();

      const samples: Array<[string, Locator, Locator]> = [
        ["pill", pill, pill],
        ["launcher", launcher, launcher],
        ["claude-main", claudeMain, claude],
        ["claude-chevron", claudeChevron, claude],
        ["codex", codex, codex],
      ];
      for (const [name, target, frame] of samples) {
        await rest(page);
        const frameBox = (await frame.boundingBox())!;
        await snapControl(page, frame, `press-${name}-${theme}-1-rest.png`, frameBox);
        await target.hover();
        await settle(page, 250);
        await snapControl(page, frame, `press-${name}-${theme}-2-hover.png`, frameBox);
        const box = (await target.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        // The first painted frame of the press, on a frozen clock: what an
        // ordinary quick click shows, since it releases before any easing ends.
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Animation.enable");
        await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
        await page.mouse.down();
        await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
        await snapControl(page, frame, `press-${name}-${theme}-2b-first-frame.png`, frameBox);
        await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
        await cdp.detach();
        await page.waitForTimeout(HOLD_MS);
        await snapControl(page, frame, `press-${name}-${theme}-3-held.png`, frameBox);
        await page.mouse.up();
        await rest(page);
      }

      writeFileSync(
        path.join(OUT_DIR, `press-metrics-${theme}.json`),
        JSON.stringify(await pressMetrics(page), null, 2)
      );

      // The pill's press against its own width: short, default and longest names.
      const widths: unknown[] = [];
      for (const [label, name, branch] of [
        ["short", "Web", "main"],
        ["long", "Customer Analytics Platform", "feature/billing-reconciliation-v2"],
      ] as const) {
        await openToolbar(page, { theme, name, branch });
        const p = page.locator(PILL);
        const b = (await p.boundingBox())!;
        await snapControl(page, p, `press-pill-${label}-${theme}-1-rest.png`, b);
        await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(HOLD_MS);
        const held = (await p.boundingBox())!;
        await snapControl(page, p, `press-pill-${label}-${theme}-3-held.png`, b);
        await page.mouse.up();
        widths.push({ label, restW: b.width, heldW: held.width, shrink: b.width - held.width });
      }
      writeFileSync(
        path.join(OUT_DIR, `press-pill-widths-${theme}.json`),
        JSON.stringify(widths, null, 2)
      );
      await openToolbar(page, { theme });

      // Reveal filmstrips on a frozen clock; the last frame is the settled open state.
      await filmReveal(
        page,
        "chevron",
        theme,
        page.locator('[data-toolbar-button-id="claude"] button').last(),
        '[role="menu"]',
        async (t) => {
          const b = (await t.boundingBox())!;
          await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
          await page.mouse.down();
          await page.mouse.up();
        }
      );
      await filmReveal(
        page,
        "pill",
        theme,
        page.locator(PILL),
        "[data-radix-popper-content-wrapper] > *",
        async (t) => {
          await t.click();
        }
      );
      // FixedDropdown, the transition-based reveal (forge stats, notifications).
      const stat = page.locator(".toolbar-stat-pill").first();
      if (await stat.isVisible().catch(() => false)) {
        await filmReveal(
          page,
          "forge",
          theme,
          stat,
          "body > div.fixed.inset-0 > div.surface-overlay",
          async (t) => {
            await t.click();
          }
        );
      }
    }

    expect(errors, errors.join("\n")).toEqual([]);
    const landed = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
    const missing = expected.filter((f) => !landed.includes(f));
    expect(missing, `missing captures: ${missing.join(", ")}`).toEqual([]);
    expect(landed.length).toBe(expected.length);
  });
});
