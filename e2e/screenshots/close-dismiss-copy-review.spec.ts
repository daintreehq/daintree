/**
 * Close, dismiss and copy icon buttons — visual-review harness.
 *
 * Drives `close-dismiss-copy-preview.html`, which mounts the REAL components that
 * carry a close X, a dismiss X or a copy button side by side, so a control that
 * differs from its siblings shows in one frame. Two neighbouring harness pages
 * add the surfaces that need their own staging: the welcome screen's cards
 * (`first-run-preview.html`) and the terminal artifact overlay
 * (`artifact-overlay-preview.html`).
 *
 * States: every section at rest in each theme; then, in the first theme, each
 * probed button hovered, keyboard-focused, and (for copy) just after a copy.
 *
 *   DAINTREE_SHOT_CDC=1 npx playwright test --project=screenshots close-dismiss-copy-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_CDC      required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR     output directory (default artifacts/close-dismiss-copy-shots)
 *   DAINTREE_SHOT_THEMES   comma-separated sweep (default daintree,bondi,namib)
 *
 * Never writes a PNG it has not verified: each target must be attached with a
 * real box, no section may have hit its error boundary, and the test counts the
 * files itself at the end.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { makeSnap, startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_CDC;

const OUT_DIR = path.resolve(
  process.env.DESIGN_CAPTURE_DIR ??
    path.join(process.cwd(), "artifacts", "close-dismiss-copy-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const SECTIONS = ["surface-close", "headers", "dismiss", "copy"];

/** The getting-started checklist portals to a fixed corner of the page. */
const CHECKLIST = "[data-getting-started-checklist]";

/** Buttons photographed hovered and focused, by section and accessible name. */
const PROBES: {
  slug: string;
  /** A `data-shot` section, or a CSS selector for a surface that portals out of it. */
  section: string;
  name: string | RegExp;
  copy?: boolean;
}[] = [
  { slug: "surface-close", section: "surface-close", name: "Close settings" },
  { slug: "artifacts-close", section: "surface-close", name: "Close artifacts" },
  { slug: "assistant-hide", section: "headers", name: "Hide Daintree Assistant" },
  { slug: "assistant-tip-dismiss", section: "headers", name: /^Dismiss/ },
  { slug: "workspace-browse", section: "headers", name: "Browse files" },
  { slug: "hint-dismiss", section: "dismiss", name: "Dismiss editing tip" },
  {
    slug: "checklist-dismiss",
    section: "[data-getting-started-checklist]",
    name: "Dismiss checklist",
  },
  { slug: "gridbar-dismiss", section: "dismiss", name: /^Dismiss/ },
  { slug: "command-copy", section: "copy", name: /^Copy command/, copy: true },
  { slug: "log-copy", section: "copy", name: /^Copy log entry/, copy: true },
  { slug: "diff-copy", section: "copy", name: /^Copy file diff/, copy: true },
];

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

async function load(page: Page, url: string, ready: string): Promise<void> {
  await stubViteHmrClient(page);
  for (let attempt = 0; ; attempt++) {
    await page.goto(url);
    try {
      await expect(page.locator(ready).first()).toBeAttached({
        timeout: attempt === 0 ? 15_000 : 30_000,
      });
      break;
    } catch (error) {
      if (attempt >= 2) throw new Error(`${url} never rendered ${ready}`, { cause: error });
    }
  }
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
}

async function openSpecimen(page: Page, theme: string): Promise<void> {
  await page.setViewportSize({ width: 1220, height: 1500 });
  await load(page, `${baseURL}/close-dismiss-copy-preview.html?theme=${theme}`, '[data-shot="copy"]');
  const errors = await page.locator("[data-shot-error]").allTextContents();
  expect(errors, `sections hit their error boundary:\n${errors.join("\n")}`).toEqual([]);
}

test("Close, dismiss and copy buttons — families, states and themes", async ({
  page,
  context,
}) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_CDC is required for the close/dismiss/copy capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_CDC=1 to run the capture");
  test.setTimeout(8 * 60_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  const snap = makeSnap(OUT_DIR);
  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const [i, theme] of THEMES.entries()) {
    await openSpecimen(page, theme);
    for (const section of SECTIONS) {
      written.push(
        await snap(page.locator(`[data-shot="${section}"]`), `${section}-${theme}.png`)
      );
    }
    written.push(await snap(page.locator(CHECKLIST), `checklist-${theme}.png`));
    if (i !== 0) continue;

    for (const probe of PROBES) {
      const section = page.locator(
        probe.section.startsWith("[") ? probe.section : `[data-shot="${probe.section}"]`
      );
      const button = section.getByRole("button", { name: probe.name }).first();
      await expect(button, `${probe.slug}: no button named ${probe.name}`).toBeAttached();
      const frame = button.locator("xpath=ancestor::*[@data-frame][1]");
      const target = (await frame.count()) > 0 ? frame : section;

      await button.hover();
      await page.waitForTimeout(250);
      written.push(await snap(target, `hover-${probe.slug}-${theme}.png`));
      await page.mouse.move(0, 0);

      await button.evaluate((el) => (el as HTMLElement).focus({ focusVisible: true } as FocusOptions));
      await page.waitForTimeout(250);
      written.push(await snap(target, `focus-${probe.slug}-${theme}.png`));
      await button.evaluate((el) => (el as HTMLElement).blur());

      if (probe.copy) {
        await button.click();
        await page.mouse.move(0, 0);
        await page.waitForTimeout(250);
        written.push(await snap(target, `copied-${probe.slug}-${theme}.png`));
      }
      await page.mouse.move(0, 0);
      await page.waitForTimeout(150);
    }

    // The welcome screen's cards and checklist, as the empty canvas shows them.
    await page.setViewportSize({ width: 1280, height: 860 });
    await load(
      page,
      `${baseURL}/first-run-preview.html?theme=${theme}&projects=0`,
      '[data-testid="agent-setup-banner"]'
    );
    written.push(await snap(page.locator("body"), `welcome-cards-${theme}.png`));
    const bannerDismiss = page.getByRole("button", { name: "Dismiss agent setup banner" });
    await bannerDismiss.hover();
    await page.waitForTimeout(250);
    written.push(
      await snap(page.locator('[data-testid="agent-setup-banner"]'), `hover-welcome-banner-${theme}.png`)
    );

    // The artifact overlay's header close and its status dismiss.
    await page.setViewportSize({ width: 900, height: 620 });
    await load(
      page,
      `${baseURL}/artifact-overlay-preview.html?theme=${theme}&fixture=populated&width=760&height=520`,
      "[data-artifact-trigger]"
    );
    await page.locator("[data-artifact-trigger]").click();
    await expect(page.getByRole("button", { name: "Close artifacts" })).toBeVisible();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(400);
    written.push(await snap(page.locator("body"), `artifact-overlay-${theme}.png`));
  }

  expect(pageErrors, `page errors during capture:\n${pageErrors.join("\n")}`).toEqual([]);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
});
