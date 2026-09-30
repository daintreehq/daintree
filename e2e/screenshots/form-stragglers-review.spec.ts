/**
 * Form stragglers — visual-review harness.
 *
 * Drives `form-stragglers-preview.html`, which mounts the REAL surfaces that
 * still carry a form control of their own: native selects, textareas, rename
 * fields, pickers, pills, key hints and switches. One section per page load
 * (`?only=`): most are modal dialogs that portal to <body>, and two open modals
 * would stack and fight over focus.
 *
 * States: every section at rest in each theme; then, in the first theme, the
 * first select of each section that has one, the command builder's textarea,
 * and the project-identity, scratch-name, preset-rename and install-method
 * controls keyboard-focused (checked against `document.activeElement` and
 * `:focus-visible` before the frame is written).
 *
 *   DAINTREE_SHOT_FORMS=1 DESIGN_CAPTURE_DIR=/abs/out \
 *     npx playwright test --project=screenshots form-stragglers-review --workers=1
 *
 * Env knobs:
 *   DAINTREE_SHOT_FORMS    required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR     required — absolute output directory, never inside the repo
 *   DAINTREE_SHOT_THEMES   comma-separated sweep (default daintree,bondi — bondi is light)
 *
 * Output: `<state>--<theme>.png`. Never writes a PNG it has not verified: each
 * target must be attached with a real box, no section may have hit its error
 * boundary, page errors fail the run, and the test counts the files itself.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { makeSnap, startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_FORMS;
const OUT_DIR = process.env.DESIGN_CAPTURE_DIR ? path.resolve(process.env.DESIGN_CAPTURE_DIR) : "";

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

interface Focus {
  /** File slug of the focus frame. */
  slug: string;
  /** The control to focus, within the page. */
  selector: string;
}

interface Shot {
  /** The `data-shot` section, the page's `?only=` and the rest frame's slug. */
  section: string;
  /**
   * Where the frame is cut from. `section` is the in-page section; `dialog` the
   * modal panel holding `anchor`; `popover` the Radix popper holding `anchor`.
   */
  frame: "section" | "dialog" | "popover";
  /** A control that must be visible before the frame counts as settled. */
  anchor: string;
  /** The control the frame is found from after `prepare`, when not the anchor. */
  frameFrom?: string;
  /** Run after the anchor settles and before the rest frame. */
  prepare?: (page: Page) => Promise<void>;
  /** Leave focus where the surface put it (its field unmounts on blur). */
  keepFocus?: boolean;
  focus?: Focus[];
}

const SHOTS: Shot[] = [
  {
    section: "recipe-editor",
    frame: "dialog",
    anchor: "[role=dialog] :is(select, button[role=combobox])",
    focus: [
      {
        slug: "recipe-editor-select",
        selector: "[role=dialog] :is(select, button[role=combobox])",
      },
    ],
  },
  {
    section: "recipe-import",
    frame: "dialog",
    anchor: "[role=dialog] :is(select, button[role=combobox])",
    focus: [
      {
        slug: "recipe-import-select",
        selector: "[role=dialog] :is(select, button[role=combobox])",
      },
    ],
  },
  {
    section: "git-init",
    frame: "dialog",
    anchor: "#git-init-template",
    focus: [{ slug: "git-init-select", selector: "#git-init-template" }],
  },
  {
    section: "command-builder",
    frame: "dialog",
    anchor: "[role=dialog] :is(select, button[role=combobox])",
    focus: [
      {
        slug: "command-builder-select",
        selector: "[role=dialog] :is(select, button[role=combobox])",
      },
      { slug: "command-builder-textarea", selector: "[role=dialog] textarea" },
    ],
  },
  {
    section: "save-fleet",
    frame: "dialog",
    anchor: '[data-testid="fleet-save-form-name"]',
    prepare: async (page) => {
      await page.getByRole("radio", { name: "Live rule" }).click();
      await expect(page.locator('[data-testid="fleet-save-rule-state"]')).toBeVisible();
    },
    focus: [{ slug: "save-fleet-select", selector: '[data-testid="fleet-save-rule-state"]' }],
  },
  {
    section: "project-identity",
    frame: "popover",
    anchor: "#project-identity-name",
    focus: [{ slug: "project-identity-name", selector: "#project-identity-name" }],
  },
  {
    section: "scratch-name",
    frame: "dialog",
    anchor: '[data-testid="scratch-create-button"]',
    frameFrom: "[data-scratch-name-input]",
    prepare: async (page) => {
      await page.locator('[data-testid="scratch-create-button"]').click();
      await expect(page.locator("[data-scratch-name-input]")).toBeFocused();
    },
    keepFocus: true,
    focus: [{ slug: "scratch-name-field", selector: "[data-scratch-name-input]" }],
  },
  {
    section: "preset-rename",
    frame: "section",
    anchor: '[data-testid="preset-edit-input"]',
    focus: [{ slug: "preset-rename-field", selector: '[data-testid="preset-edit-input"]' }],
  },
  {
    section: "agent-cli-install",
    frame: "section",
    anchor:
      '[data-shot="agent-cli-install"] :is(button[data-selected], [role=radio][aria-checked=true])',
    focus: [
      {
        slug: "agent-cli-install-picker",
        selector:
          '[data-shot="agent-cli-install"] :is(button[data-selected], [role=radio][aria-checked=true])',
      },
    ],
  },
  {
    section: "event-filters",
    frame: "section",
    anchor: '[data-shot="event-filters"] [role=group]',
  },
  {
    section: "pills",
    frame: "section",
    anchor: '[data-shot="pills"] [role=option]',
    prepare: async (page) => {
      // The imported theme sorts after every built-in; filter to it so its
      // warning pill is on screen.
      await page.locator("[data-pill-theme-browser] input").first().fill("Lowlight");
      await expect(page.locator("#theme-option-custom-lowlight")).toBeVisible();
    },
  },
  {
    section: "dialog-keyhints-new-worktree",
    frame: "dialog",
    anchor: '[data-testid="create-worktree-button"]',
  },
  {
    section: "dialog-keyhints-clone",
    frame: "dialog",
    anchor: '[role=dialog] button[aria-keyshortcuts="Enter"]',
  },
  {
    section: "automation-switches",
    frame: "section",
    anchor: '[data-shot="automation-switches"] [role=switch]',
  },
];

/** Extra frames the event-filters section adds per theme: its Filters popover, open. */
const EXTRA_PER_THEME = 1;

test.use({ deviceScaleFactor: 2 });

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!OUT_DIR)
    throw new Error("DESIGN_CAPTURE_DIR is required (an absolute path outside the repo)");
  const rel = path.relative(process.cwd(), OUT_DIR);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
    throw new Error(`DESIGN_CAPTURE_DIR must be outside the repo, got ${OUT_DIR}`);
  }
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
  baseURL = server.baseURL;
});

test.afterAll(async () => {
  await server?.close();
});

async function load(page: Page, url: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    await page.goto(url);
    try {
      await expect(page.locator("[data-preview-ready]")).toBeAttached({
        timeout: attempt === 0 ? 20_000 : 45_000,
      });
      break;
    } catch (error) {
      if (attempt >= 2) throw new Error(`${url} never rendered`, { cause: error });
    }
  }
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
}

/**
 * Marks the panel holding `anchor` — the outermost ancestor narrower than the
 * window, so a full-window scrim is never the frame — and returns it. Found
 * from the control rather than by class, so it survives a restyle of the shells.
 */
async function markPanel(page: Page, anchor: Locator): Promise<Locator> {
  await anchor.evaluate((control) => {
    document.querySelectorAll("[data-shot-dialog]").forEach((el) => {
      el.removeAttribute("data-shot-dialog");
    });
    let panel: Element = control;
    for (let el = control.parentElement; el && el !== document.body; el = el.parentElement) {
      if (el.getBoundingClientRect().width >= window.innerWidth * 0.95) break;
      panel = el;
    }
    panel.setAttribute("data-shot-dialog", "");
  });
  return page.locator("[data-shot-dialog]");
}

/** Loads one section, settles it, and returns the element its frames are cut from. */
async function openShot(page: Page, shot: Shot, theme: string): Promise<Locator> {
  const query = new URLSearchParams({ theme, only: shot.section });
  await load(page, `${baseURL}/form-stragglers-preview.html?${query}`);

  const section = page.locator(`[data-shot="${shot.section}"]`);
  await expect(section, `${shot.section}: section never mounted`).toBeAttached();
  const anchor = page.locator(shot.anchor).first();
  await expect(anchor, `${shot.section}: ${shot.anchor} never appeared`).toBeVisible({
    timeout: 20_000,
  });
  if (shot.prepare) await shot.prepare(page);
  // Dialog entry motion, lazy views and debounced counts settle.
  await page.waitForTimeout(800);
  await page.mouse.move(0, 0);

  const errors = await page.locator("[data-shot-error]").allTextContents();
  expect(errors, `${shot.section} hit its error boundary:\n${errors.join("\n")}`).toEqual([]);

  const from = shot.frameFrom ? page.locator(shot.frameFrom).first() : anchor;
  if (shot.frame === "section") return section;
  if (shot.frame === "popover") {
    return page.locator("[data-radix-popper-content-wrapper]").filter({ has: from }).first();
  }
  return markPanel(page, from);
}

async function blurAll(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
}

/** Keyboard-focuses the control and proves it holds focus AND matches :focus-visible. */
async function focusVisible(page: Page, selector: string): Promise<void> {
  const control = page.locator(selector).first();
  await control.scrollIntoViewIfNeeded();
  await control.evaluate((el) => (el as HTMLElement).focus({ focusVisible: true } as FocusOptions));
  await page.waitForTimeout(250);
  const state = await control.evaluate((el) => ({
    active: document.activeElement === el,
    visible: el.matches(":focus-visible"),
  }));
  expect(state, `${selector}: not keyboard-focused`).toEqual({ active: true, visible: true });
}

test("Form stragglers — selects, fields, pickers, pills, key hints and switches", async ({
  page,
}) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_FORMS is required for the form-stragglers capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_FORMS=1 to run the capture");
  test.setTimeout(20 * 60_000);

  await stubViteHmrClient(page);
  await page.setViewportSize({ width: 1280, height: 1100 });

  const snap = makeSnap(OUT_DIR);
  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const [i, theme] of THEMES.entries()) {
    for (const shot of SHOTS) {
      const target = await openShot(page, shot, theme);
      if (!shot.keepFocus) await blurAll(page);
      await page.waitForTimeout(200);
      written.push(await snap(target, `${shot.section}--${theme}.png`));

      if (shot.section === "event-filters") {
        await page.getByRole("button", { name: /^More filters/ }).click();
        const popover = page.locator("[data-radix-popper-content-wrapper]").first();
        await expect(popover.getByRole("button", { pressed: true }).first()).toBeVisible();
        await page.mouse.move(0, 0);
        await page.waitForTimeout(400);
        written.push(await snap(popover, `event-filters-popover--${theme}.png`));
        await page.keyboard.press("Escape");
      }

      if (i !== 0) continue;
      for (const focus of shot.focus ?? []) {
        await focusVisible(page, focus.selector);
        written.push(await snap(target, `focus-${focus.slug}--${theme}.png`));
        if (!shot.keepFocus) await blurAll(page);
      }
    }
  }

  expect(pageErrors, `page errors during capture:\n${pageErrors.join("\n")}`).toEqual([]);
  const focusCount = SHOTS.reduce((n, s) => n + (s.focus?.length ?? 0), 0);
  const expected = THEMES.length * (SHOTS.length + EXTRA_PER_THEME) + focusCount;
  expect(written.length).toBe(expected);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length, `expected ${expected} PNGs in ${OUT_DIR}`).toBe(expected);
});
