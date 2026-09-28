/**
 * Checkbox, switch and settings-reset family — visual-review harness.
 *
 * Drives `checkbox-family-preview.html`, which mounts the REAL components that
 * carry a boolean control — the ui/Checkbox and ui/Switch primitives, and every
 * hand-rolled checkbox in the dialogs, palettes, rows and pickers that use one —
 * plus every Settings "reset to default" button, in a group and in the legacy
 * grid. One section per page load (`?only=`): several of these are modal
 * dialogs that portal to <body>, and two open modals would fight over focus.
 *
 * States: every section at rest in each theme; then, in the first theme, the
 * first boolean control of each section keyboard-focused and hovered, and the
 * settings reset buttons hovered, focused and revealed by focus-within.
 *
 * Every probe is found by ROLE (checkbox, then switch), never by `input[type=…]`:
 * these controls are due to move from native inputs to Radix `button[role=checkbox]`,
 * and the harness has to photograph the after state unchanged.
 *
 *   DAINTREE_SHOT_CHECKBOX=1 DESIGN_CAPTURE_DIR=/tmp/shots \
 *     npx playwright test --project=screenshots checkbox-family-review --workers=1 --reporter=list
 *
 * Env knobs:
 *   DAINTREE_SHOT_CHECKBOX  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR      output directory (default artifacts/checkbox-family-shots)
 *   DAINTREE_SHOT_THEMES    comma-separated sweep (default daintree,bondi,namib — bondi is light)
 *
 * Never writes a PNG it has not verified: each target must be attached with a
 * real box, no section may have hit its error boundary, page errors fail the
 * run, and the test counts the files itself at the end.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { makeSnap, startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_CHECKBOX;

const OUT_DIR = path.resolve(
  process.env.DESIGN_CAPTURE_DIR ?? path.join(process.cwd(), "artifacts", "checkbox-family-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

interface Shot {
  /** The `data-shot` section, and the page's `?only=`. */
  section: string;
  /** File slug; defaults to the section. */
  slug?: string;
  /** `?state=` — the second state of a boolean the component owns. */
  state?: "on" | "off";
  /** The section opens a modal: photograph the dialog, not the page behind it. */
  dialog?: boolean;
  /** Boolean controls that must be present before the frame counts as settled. */
  minControls: number;
  /** When the section has no checkbox or switch role today, the control to probe instead. */
  fallback?: { role: "button"; name: RegExp };
}

const SHOTS: Shot[] = [
  { section: "reference", minControls: 14 },
  { section: "worktree-delete", dialog: true, minControls: 3 },
  { section: "new-worktree", dialog: true, minControls: 2 },
  { section: "new-worktree", slug: "new-worktree-on", state: "on", dialog: true, minControls: 2 },
  { section: "assign-toggle", minControls: 3 },
  { section: "quick-create", dialog: true, minControls: 1 },
  {
    section: "quick-create",
    slug: "quick-create-off",
    state: "off",
    dialog: true,
    minControls: 1,
  },
  { section: "commit-panel", dialog: true, minControls: 1 },
  { section: "file-stage-row", minControls: 3 },
  {
    section: "diff-sidebar",
    minControls: 0,
    fallback: { role: "button", name: /as viewed$/ },
  },
  { section: "plugin-uninstall", dialog: true, minControls: 1 },
  { section: "agent-cli", minControls: 4 },
  { section: "crash-recovery", dialog: true, minControls: 4 },
  { section: "fleet-picker", minControls: 3 },
  { section: "settings-reset", minControls: 3 },
];

/** Resets are found by name — `includeHidden`, because the legacy ones sit `visibility: hidden` at rest. */
const RESET_NAME = /^Reset .* to default$/;

test.use({ deviceScaleFactor: 2 });

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
  baseURL = server.baseURL;
});

test.afterAll(async () => {
  await server?.close();
});

function booleanControls(scope: Locator): Locator {
  return scope.getByRole("checkbox").or(scope.getByRole("switch"));
}

async function load(page: Page, url: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    await page.goto(url);
    try {
      await expect(page.locator("[data-preview-ready]")).toBeAttached({
        timeout: attempt === 0 ? 15_000 : 30_000,
      });
      break;
    } catch (error) {
      if (attempt >= 2) throw new Error(`${url} never rendered`, { cause: error });
    }
  }
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
}

/** Loads one section and returns the element its frames are cut from. */
async function openShot(page: Page, shot: Shot, theme: string): Promise<Locator> {
  const query = new URLSearchParams({ theme, only: shot.section });
  if (shot.state) query.set("state", shot.state);
  await load(page, `${baseURL}/checkbox-family-preview.html?${query}`);

  const section = page.locator(`[data-shot="${shot.section}"]`);
  await expect(section).toBeAttached();
  // A dialog's controls live in the modal that holds them; nested confirms portal
  // after their host, so the last one holding a control is the one on top.
  const target = shot.dialog
    ? page
        .locator('[aria-modal="true"]')
        .filter({ has: page.getByRole("checkbox").or(page.getByRole("switch")) })
        .last()
    : section;

  if (shot.dialog) {
    await expect(
      target,
      `${shot.section}: no modal holding a checkbox or switch opened`
    ).toBeVisible({
      timeout: 15_000,
    });
  }
  if (shot.minControls > 0) {
    await expect
      .poll(() => booleanControls(target).count(), {
        message: `${shot.section}: expected at least ${shot.minControls} checkbox/switch controls`,
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(shot.minControls);
  }
  // Dialog entry motion and debounced counts settle; fonts are already in.
  await page.waitForTimeout(700);
  await page.mouse.move(0, 0);

  const errors = await page.locator("[data-shot-error]").allTextContents();
  expect(errors, `${shot.section} hit its error boundary:\n${errors.join("\n")}`).toEqual([]);
  if (!shot.dialog) return target;

  // The modal element is often the full-window scrim; cut the frame from the
  // panel instead — the outermost ancestor of a control that is narrower than
  // the window. Found from the control rather than by class, so it survives
  // any restyle of the dialog shells.
  await booleanControls(target)
    .first()
    .evaluate((control) => {
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

async function focusVisible(control: Locator): Promise<void> {
  await control.evaluate((el) => (el as HTMLElement).focus({ focusVisible: true } as FocusOptions));
}

async function blurAll(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
}

test("Checkbox, switch and settings reset — families, states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_CHECKBOX is required for the checkbox-family capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_CHECKBOX=1 to run the capture");
  test.setTimeout(15 * 60_000);

  await stubViteHmrClient(page);
  await page.setViewportSize({ width: 1280, height: 1000 });

  const snap = makeSnap(OUT_DIR);
  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const [i, theme] of THEMES.entries()) {
    for (const shot of SHOTS) {
      const slug = shot.slug ?? shot.section;
      const target = await openShot(page, shot, theme);
      written.push(await snap(target, `${slug}-${theme}.png`));
      if (i !== 0) continue;

      // The first boolean control, keyboard-focused and then hovered.
      const control =
        shot.minControls > 0
          ? booleanControls(target).first()
          : shot.fallback
            ? target.getByRole(shot.fallback.role, { name: shot.fallback.name }).first()
            : null;
      if (control) {
        await expect(control, `${slug}: no control to probe`).toBeAttached();
        await control.scrollIntoViewIfNeeded();
        await focusVisible(control);
        await page.waitForTimeout(250);
        written.push(await snap(target, `focus-${slug}-${theme}.png`));
        await blurAll(page);

        await control.hover();
        await page.waitForTimeout(250);
        written.push(await snap(target, `hover-${slug}-${theme}.png`));
        await page.mouse.move(0, 0);
        await page.waitForTimeout(150);
      }

      if (shot.section !== "settings-reset") continue;

      const legacy = target.locator("[data-settings-legacy]");
      const legacyFrame = legacy.locator("xpath=ancestor::*[@data-frame][1]");
      const grouped = target.locator("[data-settings-grouped]");
      const groupedFrame = grouped.locator("xpath=ancestor::*[@data-frame][1]");
      const legacyInput = legacy.getByRole("textbox").first();

      // Hover a non-group row: does the reset appear on hover?
      await legacyInput.hover();
      await page.waitForTimeout(250);
      written.push(await snap(legacyFrame, `hover-settings-legacy-row-${theme}.png`));
      await page.mouse.move(0, 0);
      await page.waitForTimeout(150);

      // Keyboard focus on the non-group reset itself.
      const legacyReset = legacy
        .getByRole("button", { name: RESET_NAME, includeHidden: true })
        .first();
      await expect(legacyReset, "no legacy reset button").toBeAttached();
      await focusVisible(legacyReset);
      await page.waitForTimeout(250);
      written.push(await snap(legacyFrame, `focus-settings-legacy-reset-${theme}.png`));
      await blurAll(page);

      // Keyboard focus on a grouped row's reset.
      const groupedReset = grouped
        .getByRole("button", { name: RESET_NAME, includeHidden: true })
        .first();
      await expect(groupedReset, "no grouped reset button").toBeAttached();
      await focusVisible(groupedReset);
      await page.waitForTimeout(250);
      written.push(await snap(groupedFrame, `focus-settings-grouped-reset-${theme}.png`));
      await blurAll(page);

      // Keyboard focus inside the non-group text field: does focus-within reveal the reset?
      await focusVisible(legacyInput);
      await page.waitForTimeout(250);
      written.push(await snap(legacyFrame, `focus-within-settings-legacy-input-${theme}.png`));
      await blurAll(page);
    }
  }

  expect(pageErrors, `page errors during capture:\n${pageErrors.join("\n")}`).toEqual([]);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
});
