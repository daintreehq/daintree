/**
 * Toolbar toggle tooltip and plugin tray visual-review harness.
 *
 * Drives `toolbar-toggles-preview.html`, which mounts the real Problems, web
 * chat, voice recording and plugin tray buttons against seeded stores, and the
 * main `toolbar-preview.html` for the sidebar toggle. Each shot hovers one
 * toggle and photographs its tooltip, or opens the plugin tray menu. A JSON
 * sidecar records each trigger's accessible name and pressed/expanded state,
 * so name changes can be checked against the attribute rather than squinted at.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_TOOLBAR_TOGGLES is set.
 *
 *   DAINTREE_SHOT_TOOLBAR_TOGGLES=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots toolbar-toggles-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_TOOLBAR_TOGGLES  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR              required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES           comma-separated sweep (default daintree,svalbard)
 *
 * Never writes a PNG it has not verified, and counts the files itself at the end.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_TOOLBAR_TOGGLES;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,svalbard")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

test.use({ deviceScaleFactor: 2 });

const OPEN_TOOLTIP =
  '[data-radix-popper-content-wrapper] > [data-state="delayed-open"], [data-radix-popper-content-wrapper] > [data-state="instant-open"]';
const PAD = 12;

const FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

interface Shot {
  state: string;
  slot: "problems" | "portal" | "voice" | "tray";
}

const SHOTS: Shot[] = [
  { state: "problems-clean", slot: "problems" },
  { state: "problems-errors", slot: "problems" },
  { state: "problems-open", slot: "problems" },
  { state: "portal-closed", slot: "portal" },
  { state: "portal-open", slot: "portal" },
  { state: "voice-recording", slot: "voice" },
  { state: "voice-paused", slot: "voice" },
  { state: "tray", slot: "tray" },
];

let server: PreviewServer | undefined;
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

async function settle(page: Page, ms = 200): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function describeTrigger(trigger: Locator) {
  return trigger.evaluate((el) => ({
    ariaLabel: el.getAttribute("aria-label"),
    ariaPressed: el.getAttribute("aria-pressed"),
    ariaExpanded: el.getAttribute("aria-expanded"),
    ariaKeyshortcuts: el.getAttribute("aria-keyshortcuts"),
  }));
}

/** Clip the union of the trigger and the overlay it opened, and verify both are in it. */
async function snap(page: Page, file: string, trigger: Locator, overlay: Locator): Promise<void> {
  expected.push(file);
  await expect(overlay).toBeVisible({ timeout: 5_000 });
  await settle(page);
  const a = await trigger.boundingBox();
  const b = await overlay.boundingBox();
  if (!a || !b || b.width < 20 || b.height < 10) {
    throw new Error(
      `${file}: no real boxes (trigger ${JSON.stringify(a)}, overlay ${JSON.stringify(b)})`
    );
  }
  const x = Math.max(0, Math.min(a.x, b.x) - PAD);
  const y = Math.max(0, Math.min(a.y, b.y) - PAD);
  const clip = {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) + PAD - x,
    height: Math.max(a.y + a.height, b.y + b.height) + PAD - y,
  };
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, clip });
  if (!existsSync(out)) throw new Error(`${file}: screenshot did not land`);
  writeFileSync(
    out.replace(/\.png$/, ".json"),
    JSON.stringify(
      { trigger: await describeTrigger(trigger), overlayText: await overlay.innerText() },
      null,
      2
    )
  );
}

test.describe("toolbar toggles review", () => {
  test("captures", async ({ page }) => {
    test.info().annotations.push({
      type: "conditional-skip",
      description: "DAINTREE_SHOT_TOOLBAR_TOGGLES is required for the toolbar toggles capture",
    });
    test.skip(!ENABLED, "Set DAINTREE_SHOT_TOOLBAR_TOGGLES to run the toolbar toggles capture");
    test.setTimeout(600_000);
    await stubViteHmrClient(page);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.stack ?? String(e)));

    for (const theme of THEMES) {
      for (const shot of SHOTS) {
        await page.setViewportSize({ width: 900, height: 520 });
        const url = `${server!.baseURL}/toolbar-toggles-preview.html?theme=${theme}&state=${shot.state}`;
        await page.goto(url, { waitUntil: "load" });
        await page.addStyleTag({ content: FREEZE_CSS });
        const trigger = page.locator(`[data-harness-slot="${shot.slot}"] button`).first();
        await trigger.waitFor({ state: "visible", timeout: 30_000 }).catch((e: unknown) => {
          throw new Error(
            `${shot.state}: trigger never mounted (${url}): ${String(e)}\n${errors.join("\n")}`
          );
        });
        await page.mouse.move(0, 0);
        await settle(page, 300);
        const file = `${theme}-${shot.state}.png`;
        if (shot.slot === "tray") {
          await trigger.click();
          await snap(page, file, trigger, page.locator('[role="menu"]'));
          // The long row highlighted, so its hover-revealed pin is in the frame too.
          await page.locator('[data-testid="plugin-tray-row-plugin.acme.release.audit"]').hover();
          await snap(
            page,
            `${theme}-tray-long-row-hover.png`,
            trigger,
            page.locator('[role="menu"]')
          );
        } else {
          await trigger.hover();
          await snap(page, file, trigger, page.locator(OPEN_TOOLTIP).first());
        }
      }

      // The sidebar toggle lives in the Toolbar's own registry, so it is photographed
      // on the real strip.
      await page.setViewportSize({ width: 1440, height: 240 });
      await page.goto(`${server!.baseURL}/toolbar-preview.html?theme=${theme}&fixture=owner`, {
        waitUntil: "load",
      });
      await page.addStyleTag({ content: FREEZE_CSS });
      const sidebar = page.locator("[data-sidebar-toggle]").first();
      await sidebar.waitFor({ state: "visible", timeout: 30_000 });
      await page.mouse.move(700, 200);
      await settle(page, 300);
      await sidebar.hover();
      await snap(page, `${theme}-sidebar.png`, sidebar, page.locator(OPEN_TOOLTIP).first());
    }

    expect(errors, errors.join("\n")).toEqual([]);
    const landed = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
    const missing = expected.filter((f) => !landed.includes(f));
    expect(missing, `missing captures: ${missing.join(", ")}`).toEqual([]);
    expect(landed.length).toBe(expected.length);
  });
});
