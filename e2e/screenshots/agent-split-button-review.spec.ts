/**
 * Agent split button visual-review harness.
 *
 * Photographs the toolbar agent split button and its preset menu the way a
 * person reaches each state — at rest, opened by pointer, opened and walked by
 * keyboard, and after the keyboard "set as default" key — and records the
 * chevron's computed rotation and transition beside each shot, including under
 * reduced motion, so the disclosure recipe can be checked against numbers.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_AGENT_SPLIT=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots agent-split-button-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_AGENT_SPLIT  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES       theme sweep (default daintree,bondi)
 *
 * Output: `<theme>-<state>.png` plus `<theme>-<state>.json`. Every state asserts
 * what it meant to reach before writing, and the file count is checked at the end.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_AGENT_SPLIT;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const URL = "/toolbar-preview.html?fixture=owner&platform=mac";
const SPLIT = '[data-toolbar-button-id="claude"] .toolbar-agent-split';
const MENU = '[role="menu"]:visible';
const PAD = 24;
const STATES = ["rest", "open", "hover-row", "kbd-row", "kbd-set-default"] as const;

test.use({ deviceScaleFactor: 2, actionTimeout: 15_000 });

const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

let server: PreviewServer | undefined;

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

async function load(page: Page, theme: string, freeze = true): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 520 });
  await page.mouse.move(0, 0);
  const url = `${server!.baseURL}${URL}&theme=${theme}`;
  const ready = page.locator(SPLIT).first();
  for (let attempt = 0; ; attempt++) {
    await page.goto(attempt === 0 ? url : "about:blank");
    if (attempt > 0) await page.goto(url, { waitUntil: "load" });
    try {
      await ready.waitFor({ state: "visible", timeout: attempt === 0 ? 30_000 : 60_000 });
      break;
    } catch (error) {
      if (attempt >= 2) throw new Error(`${SPLIT} never appeared at ${url}`, { cause: error });
    }
  }
  if (freeze) await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

const chevronOf = (page: Page) => page.locator(`${SPLIT} .toolbar-agent-split-toggle`).first();

async function chevronStyle(page: Page) {
  return chevronOf(page)
    .locator("svg")
    .evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        // Tailwind v4's rotate-* writes the individual `rotate` property.
        rotate: cs.rotate,
        transform: cs.transform,
        transitionProperty: cs.transitionProperty,
        transitionDuration: cs.transitionDuration,
        ariaHidden: el.getAttribute("aria-hidden"),
        animatedChevron: el.hasAttribute("data-animated-chevron"),
      };
    });
}

function rowNamed(page: Page, name: string): Locator {
  return page.locator(MENU).getByRole("menuitem").filter({ hasText: name }).first();
}

async function rowReport(row: Locator) {
  return row.evaluate((el) => ({
    text: el.textContent,
    visibleText: (el as HTMLElement).innerText,
    highlighted: el.hasAttribute("data-highlighted"),
    focused: document.activeElement === el,
    isDefault: !!el.querySelector('[data-zone="gutter"] .lucide-check'),
    gutterTitle: el.querySelector('[data-zone="gutter"]')?.getAttribute("title") ?? null,
    visibleHintOpacity: (() => {
      const hint = el.querySelector(':scope > [aria-hidden="true"]');
      return hint ? getComputedStyle(hint).opacity : null;
    })(),
    width: Math.round(el.getBoundingClientRect().width),
  }));
}

async function shoot(page: Page, theme: string, state: string, targets: Locator[], extra: object) {
  const boxes = [];
  for (const t of targets) {
    const b = await t.boundingBox();
    if (!b || b.width < 8 || b.height < 8) throw new Error(`${theme}-${state}: target has no box`);
    boxes.push(b);
  }
  const vp = page.viewportSize()!;
  const x0 = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.x)) - PAD));
  const y0 = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.y)) - PAD));
  const x1 = Math.min(vp.width, Math.ceil(Math.max(...boxes.map((b) => b.x + b.width)) + PAD));
  const y1 = Math.min(vp.height, Math.ceil(Math.max(...boxes.map((b) => b.y + b.height)) + PAD));
  const file = path.join(OUT_DIR, `${theme}-${state}.png`);
  await page.screenshot({ path: file, clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });
  if (!existsSync(file)) throw new Error(`${theme}-${state}: screenshot did not land`);
  writeFileSync(
    file.replace(/\.png$/, ".json"),
    JSON.stringify({ theme, state, ...extra }, null, 2)
  );
}

/**
 * Runs before any module. The preview's inert bridge answers the settings write
 * with `undefined`, so the store's optimistic default pick would throw and roll
 * back. A write that never settles holds the optimistic state, which is what
 * the real app shows until main answers.
 */
function holdAgentSettingsWrites(): void {
  let bridge: unknown;
  Object.defineProperty(window, "electron", {
    configurable: true,
    get: () => bridge,
    set: (value: object) => {
      bridge = new Proxy(value, {
        get: (target, key) => {
          const ns: unknown = Reflect.get(target, key);
          if (key !== "agentSettings" || !ns || typeof ns !== "object") return ns;
          return new Proxy(ns, {
            get: (inner, name) =>
              name === "set" ? () => new Promise(() => {}) : Reflect.get(inner, name),
          });
        },
      });
    },
  });
}

async function openByKeyboard(page: Page): Promise<Locator> {
  const chevron = chevronOf(page);
  await chevron.focus();
  await page.keyboard.press("Enter");
  const menu = page.locator(MENU).last();
  await expect(menu, "keyboard Enter never opened the preset menu").toBeVisible();
  return menu;
}

test.describe("agent split button review", () => {
  test("captures", async ({ browser }) => {
    test.info().annotations.push({
      type: "conditional-skip",
      description: "DAINTREE_SHOT_AGENT_SPLIT is required for the agent split button capture",
    });
    test.skip(!ENABLED, "Set DAINTREE_SHOT_AGENT_SPLIT to run the agent split button capture");
    test.setTimeout(10 * 60_000);
    const context = await browser.newContext();
    const errors: string[] = [];
    const unmet: string[] = [];
    try {
      for (const theme of THEMES) {
        const page = await context.newPage();
        await stubViteHmrClient(page);
        await page.addInitScript(holdAgentSettingsWrites);
        page.on("pageerror", (e) => errors.push(`${theme}: ${e.stack ?? e.message}`));

        // rest
        await load(page, theme);
        const split = page.locator(SPLIT).first();
        await expect(chevronOf(page)).toHaveAttribute("aria-expanded", "false");
        await shoot(page, theme, "rest", [split], { chevron: await chevronStyle(page) });

        // open by pointer
        await chevronOf(page).click();
        const menu = page.locator(MENU).last();
        await expect(menu).toBeVisible();
        await expect(chevronOf(page)).toHaveAttribute("aria-expanded", "true");
        await page.waitForTimeout(250);
        await shoot(page, theme, "open", [split, menu], { chevron: await chevronStyle(page) });
        // pointer hover: the gutter hint appears, the keyboard hint must not
        const hovered = rowNamed(page, "Plan first");
        await hovered.hover();
        await expect(hovered).toHaveAttribute("data-highlighted", "");
        await page.waitForTimeout(150);
        const hoverReport = await rowReport(hovered);
        if (hoverReport.visibleHintOpacity !== "0") {
          unmet.push(`${theme}: keyboard hint showed on pointer hover`);
        }
        await shoot(page, theme, "hover-row", [split, menu], { row: hoverReport });
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();

        // keyboard walkthrough: open, arrow to a non-default preset
        await load(page, theme);
        const kbdMenu = await openByKeyboard(page);
        const firstFocused = await page.evaluate(() => document.activeElement?.textContent ?? "");
        await page.keyboard.press("ArrowDown");
        const plan = rowNamed(page, "Plan first");
        await expect(plan).toBeFocused();
        const before = await rowReport(plan);
        if (before.isDefault) throw new Error(`${theme}: "Plan first" was already the default`);
        if (before.visibleHintOpacity !== "1") {
          unmet.push(`${theme}: keyboard hint hidden on the focused row`);
        }
        await page.waitForTimeout(150);
        await shoot(page, theme, "kbd-row", [page.locator(SPLIT).first(), kbdMenu], {
          firstFocused,
          row: before,
        });

        // set as default from the keyboard: the menu stays open, focus stays on the row
        await page.keyboard.press("d");
        await expect(kbdMenu, "set-default key closed the menu").toBeVisible();
        await expect(plan).toBeFocused();
        // Recorded rather than thrown here, so a baseline run of the old key
        // contract still photographs what pressing D does to it; asserted at the end.
        const moved = await expect
          .poll(() => rowReport(plan).then((r) => r.isDefault), { timeout: 3_000 })
          .toBe(true)
          .then(() => true)
          .catch(() => false);
        if (!moved) unmet.push(`${theme}: D did not move the default to "Plan first"`);
        const agentDefault = await rowReport(rowNamed(page, "Agent default"));
        await page.waitForTimeout(150);
        await shoot(page, theme, "kbd-set-default", [page.locator(SPLIT).first(), kbdMenu], {
          row: await rowReport(plan),
          agentDefault,
        });

        // reduced motion: the rotation still lands, the transition does not run
        await page.emulateMedia({ reducedMotion: "reduce" });
        await load(page, theme, false);
        await chevronOf(page).click();
        await expect(page.locator(MENU).last()).toBeVisible();
        writeFileSync(
          path.join(OUT_DIR, `${theme}-reduced-motion.json`),
          JSON.stringify({ theme, chevronOpen: await chevronStyle(page) }, null, 2)
        );
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await load(page, theme, false);
        await chevronOf(page).click();
        await expect(page.locator(MENU).last()).toBeVisible();
        await page.waitForTimeout(300);
        writeFileSync(
          path.join(OUT_DIR, `${theme}-full-motion.json`),
          JSON.stringify({ theme, chevronOpen: await chevronStyle(page) }, null, 2)
        );
        await page.close();
      }
    } finally {
      await context.close();
    }
    expect(errors).toEqual([]);
    const pngs = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
    expect(pngs.length).toBe(THEMES.length * STATES.length);
    expect(unmet).toEqual([]);
  });
});
