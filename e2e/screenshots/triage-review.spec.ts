/**
 * Triage panel review harness.
 *
 * Drives the panel's own preview entry (`triage-preview.html`) rather than
 * booting Electron: the real `TriageView`, `TriageCard` and `AppPaletteDialog`,
 * the real theme tokens and `index.css`, with the fleet and triage stores seeded
 * in the shapes main pushes. The live route needs a fleet of real agents parked
 * at menus, questions and errors plus two provider keys; the fixtures reach every
 * card kind at once, and the states nobody sees in a quiet afternoon.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_TRIAGE is set.
 *
 *   DAINTREE_SHOT_TRIAGE=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots triage-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_TRIAGE   required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR      required — an ABSOLUTE directory outside the repo
 *   DAINTREE_SHOT_THEMES   themes to sweep (default daintree,bondi,namib)
 *
 * Every capture asserts the state it claims before it is written, and the test
 * counts the files on disk at the end rather than trusting its own exit code.
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";
import type { TriageFixture } from "../../src/components/Triage/__preview__/fixtures";

const ENABLED = !!process.env.DAINTREE_SHOT_TRIAGE;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const CURRENT_PROJECT = "a".repeat(64);

const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

test.use({ deviceScaleFactor: 2 });

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!path.isAbsolute(OUT_DIR)) {
    throw new Error("DAINTREE_SHOT_DIR must be an absolute directory outside the repo");
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const repoRoot = realpathSync(process.cwd());
  const outReal = realpathSync(OUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DAINTREE_SHOT_DIR must be outside the repo (${OUT_DIR})`);
  }
  for (const file of readdirSync(OUT_DIR)) {
    if (file.endsWith(".png")) rmSync(path.join(OUT_DIR, file), { force: true });
  }
  server = await startPreviewServer();
  baseURL = server.baseURL;
});

test.afterAll(async () => {
  await server?.close();
});

const dialog = (page: Page) => page.locator('[role="dialog"][aria-label="Triage"]');
const cards = (page: Page) => dialog(page).locator("[data-triage-card]");

async function load(page: Page, theme: string, fixture: TriageFixture): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto(
    `${baseURL}/triage-preview.html?theme=${theme}&fixture=${fixture}&projectId=${CURRENT_PROJECT}`
  );
  // Generous: a first load after a new import re-optimises Vite's deps.
  await expect(page.locator("[data-preview-shell]")).toBeAttached({ timeout: 60_000 });
  await expect(dialog(page)).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: FREEZE_CSS });
  // The panel lands keyboard focus on its first card two frames after open.
  await page.waitForTimeout(250);
  if (errors.length > 0) throw new Error(`${fixture}: page errors — ${errors.join("; ")}`);
}

/** Never write an unverified frame: the dialog must have a real box and the cards it claims. */
async function snap(page: Page, file: string, expectCards: number | "none"): Promise<string> {
  const target = dialog(page);
  const box = await target.boundingBox();
  if (!box || box.width < 400 || box.height < 120) {
    throw new Error(`${file}: panel has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  if (expectCards === "none") await expect(cards(page)).toHaveCount(0);
  else await expect(cards(page)).toHaveCount(expectCards);

  const vp = page.viewportSize()!;
  const pad = 24;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    clip: {
      x,
      y,
      width: Math.min(box.width + pad * 2, vp.width - x),
      height: Math.min(box.height + pad * 2, vp.height - y),
    },
  });
  return out;
}

const FLEET_CARDS = 9;

for (const theme of THEMES) {
  test(`triage panel — ${theme}`, async ({ page }) => {
    test.skip(!ENABLED, "DAINTREE_SHOT_TRIAGE not set");
    test.setTimeout(240_000);
    const written: string[] = [];

    await load(page, theme, "fleet");
    await expect(cards(page).first()).toBeFocused();
    written.push(await snap(page, `${theme}--01-fleet.png`, FLEET_CARDS));

    // The bottom of the list: the scroller holds the calm rows below the fold.
    await dialog(page)
      .locator("[data-triage-card]")
      .last()
      .evaluate((el) => el.scrollIntoView({ block: "end" }));
    await page.waitForTimeout(100);
    written.push(await snap(page, `${theme}--02-fleet-scrolled.png`, FLEET_CARDS));

    // Keyboard onto a compact working row.
    await load(page, theme, "fleet");
    await expect(cards(page).first()).toBeFocused();
    for (let i = 0; i < 6; i += 1) await page.keyboard.press("ArrowDown");
    await expect(cards(page).nth(6)).toBeFocused();
    await expect(cards(page).nth(6)).toHaveAttribute("data-kind", "working");
    written.push(await snap(page, `${theme}--03-keyboard-on-working.png`, FLEET_CARDS));

    // Answer the first menu with its key, then start a reply on the question.
    await load(page, theme, "fleet");
    await expect(cards(page).first()).toBeFocused();
    await page.keyboard.press("1");
    await expect(page.locator("body")).toHaveAttribute("data-triage-last", /"choose"/);
    const question = dialog(page).locator('[data-triage-card][data-kind="question"]').first();
    await question.getByRole("textbox").fill("Start with the contract tests");
    await expect(question.getByRole("textbox")).toBeFocused();
    written.push(await snap(page, `${theme}--04-answered-and-replying.png`, FLEET_CARDS));

    await load(page, theme, "describing");
    await expect(dialog(page).getByText("Approve the edit to electron/store.ts")).toHaveCount(0);
    written.push(await snap(page, `${theme}--05-describing.png`, FLEET_CARDS));

    await load(page, theme, "unconfigured");
    await expect(dialog(page).getByText("Screen reading is off")).toBeVisible();
    written.push(await snap(page, `${theme}--06-unconfigured.png`, FLEET_CARDS));

    await load(page, theme, "read-error");
    await expect(dialog(page).getByText("Some cards couldn't be read")).toBeVisible();
    written.push(await snap(page, `${theme}--07-read-error.png`, FLEET_CARDS));

    await load(page, theme, "calm");
    written.push(await snap(page, `${theme}--08-calm.png`, 3));

    await load(page, theme, "empty");
    await expect(dialog(page).getByText("Launch an agent and it shows up here.")).toBeVisible();
    written.push(await snap(page, `${theme}--09-empty.png`, "none"));

    await load(page, theme, "long");
    written.push(await snap(page, `${theme}--10-long.png`, FLEET_CARDS));

    const onDisk = readdirSync(OUT_DIR).filter((f) => f.startsWith(`${theme}--`));
    expect(onDisk.sort()).toEqual(written.map((f) => path.basename(f)).sort());
  });
}
