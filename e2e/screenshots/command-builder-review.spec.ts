/**
 * Command builder review harness.
 *
 * Drives the builder's own preview entry (`command-builder-preview.html`) rather
 * than booting Electron: the real `CommandBuilder` and `AppDialog`, the real
 * theme tokens and `index.css`, fed builder manifests in the shape
 * `CommandService.getBuilder()` returns. The builder's loading and load-error
 * dialogs come from the real `CommandPickerHost` over a seeded command store.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_COMMAND_BUILDER is set.
 *
 *   DAINTREE_SHOT_COMMAND_BUILDER=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots command-builder-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_COMMAND_BUILDER  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR              required — an ABSOLUTE directory outside the repo
 *   DAINTREE_SHOT_THEMES           themes to sweep (default daintree,bondi,namib)
 *
 * Every capture asserts the state it claims before it is written, and the test
 * counts the files on disk at the end rather than trusting its own exit code.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_COMMAND_BUILDER;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

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

const dialog = (page: Page) => page.getByRole("dialog");
// The footer's forward action — Next, or the run action on the last step — is
// always the dialog's last button.
const primary = (page: Page) => dialog(page).getByRole("button").last();
const fields = (page: Page) => dialog(page).locator("input, textarea, select, [role='checkbox']");

async function load(page: Page, query: string): Promise<void> {
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: 1200, height: 860 });
  await page.goto(`${baseURL}/command-builder-preview.html?${query}`);
  // Generous: a first load after a new import re-optimises Vite's deps.
  await expect(page.locator("[data-preview-shell]")).toBeAttached({ timeout: 30_000 });
  await expect(dialog(page)).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.waitForTimeout(200);
}

/** Never write an unverified frame: the dialog must have a real box and the controls it claims. */
async function snap(page: Page, file: string, expectFields: number | "none"): Promise<string> {
  const target: Locator = dialog(page);
  const box = await target.boundingBox();
  if (!box || box.width < 300 || box.height < 120) {
    throw new Error(`${file}: dialog has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  if (expectFields === "none") await expect(fields(page)).toHaveCount(0);
  else await expect(fields(page)).toHaveCount(expectFields);

  const vp = page.viewportSize()!;
  const pad = 32;
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

async function executed(page: Page): Promise<void> {
  await expect(page.locator("body[data-executed-args]")).toBeAttached();
}

/** The wizard walked to its last step with the first checkbox ticked and the second keyboard-focused. */
async function wizardToLastStep(page: Page): Promise<void> {
  await dialog(page).getByRole("combobox").selectOption("canary");
  await dialog(page).getByRole("textbox").fill("spring-cleanup");
  await primary(page).click();
  await dialog(page).getByRole("spinbutton").fill("25");
  await primary(page).click();
  const boxes = dialog(page).getByRole("checkbox");
  await expect(boxes).toHaveCount(2);
  await boxes.first().click();
  await expect(boxes.first()).toBeChecked();
  await page.keyboard.press("Shift");
  await boxes.last().focus();
  await expect(boxes.last()).toBeFocused();
}

test("Command builder — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_COMMAND_BUILDER is required for the command builder capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_COMMAND_BUILDER=1 to run the capture");
  test.setTimeout(15 * 60_000);

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const theme of THEMES) {
    const t = `theme=${theme}`;

    // The shipped create-issue builder: one step, text + textarea + text.
    await load(page, `${t}&fixture=create-issue`);
    written.push(await snap(page, `01-create-rest--${theme}.png`, 3));

    await dialog(page).getByRole("textbox").nth(0).fill("Command builder loses focus on Execute");
    await dialog(page)
      .getByRole("textbox")
      .nth(1)
      .fill("Pressing Execute from the keyboard drops focus to the page behind the dialog.");
    await dialog(page).getByRole("textbox").nth(2).fill("bug, ui");
    written.push(await snap(page, `02-create-filled--${theme}.png`, 3));

    await load(page, `${t}&fixture=create-issue&outcome=pending`);
    await dialog(page).getByRole("textbox").nth(0).fill("Command builder loses focus on Execute");
    await primary(page).click();
    await executed(page);
    await page.waitForTimeout(150);
    written.push(await snap(page, `03-create-executing--${theme}.png`, 3));

    await load(page, `${t}&fixture=create-issue&outcome=error`);
    await dialog(page).getByRole("textbox").nth(0).fill("Command builder loses focus on Execute");
    await primary(page).click();
    await executed(page);
    await expect(dialog(page).getByText("Cannot reach GitHub", { exact: false })).toBeVisible();
    written.push(await snap(page, `04-create-error--${theme}.png`, 3));

    await load(page, `${t}&fixture=create-issue&outcome=success`);
    await dialog(page).getByRole("textbox").nth(0).fill("Command builder loses focus on Execute");
    await primary(page).click();
    await executed(page);
    await expect(fields(page)).toHaveCount(0);
    written.push(await snap(page, `05-create-success--${theme}.png`, "none"));

    // The shipped work-issue builder: number + two text fields, long help.
    await load(page, `${t}&fixture=work-issue`);
    written.push(await snap(page, `06-work-rest--${theme}.png`, 3));

    await dialog(page).getByRole("spinbutton").fill("0");
    await primary(page).click();
    await expect(dialog(page).locator('[aria-invalid="true"]')).toHaveCount(1);
    written.push(await snap(page, `07-work-invalid--${theme}.png`, 3));

    await load(page, `${t}&fixture=work-issue&outcome=success`);
    await dialog(page).getByRole("spinbutton").fill("12391");
    await primary(page).click();
    await executed(page);
    await expect(fields(page)).toHaveCount(0);
    written.push(await snap(page, `08-work-success--${theme}.png`, "none"));

    // A plugin-shaped three-step manifest.
    await load(page, `${t}&fixture=wizard`);
    written.push(await snap(page, `09-wizard-step1--${theme}.png`, 2));

    await dialog(page).getByRole("combobox").selectOption("canary");
    await dialog(page).getByRole("textbox").fill("spring-cleanup");
    await primary(page).click();
    await dialog(page).getByRole("spinbutton").fill("400");
    await primary(page).click();
    await expect(dialog(page).locator('[aria-invalid="true"]')).toHaveCount(1);
    written.push(await snap(page, `10-wizard-step2-invalid--${theme}.png`, 2));

    await load(page, `${t}&fixture=wizard`);
    await wizardToLastStep(page);
    written.push(await snap(page, `11-wizard-step3-focus--${theme}.png`, 2));

    await primary(page).click();
    await executed(page);
    await expect(fields(page)).toHaveCount(0);
    written.push(await snap(page, `12-wizard-success--${theme}.png`, "none"));

    await load(page, `${t}&fixture=empty`);
    written.push(await snap(page, `13-no-steps--${theme}.png`, "none"));

    // The host's own dialogs. Loading is Doherty-gated, so it appears after 400ms.
    await load(page, `${t}&host=loading`);
    written.push(await snap(page, `14-host-loading--${theme}.png`, "none"));

    await load(page, `${t}&host=load-error`);
    written.push(await snap(page, `15-host-load-error--${theme}.png`, "none"));
  }

  // Forced colours, one theme: the checkbox and the step state have to survive losing their fills.
  await page.emulateMedia({ forcedColors: "active" });
  await load(page, "theme=daintree&fixture=wizard");
  await wizardToLastStep(page);
  written.push(await snap(page, `16-forced-colors-step3--daintree.png`, 2));
  await load(page, "theme=daintree&fixture=create-issue&outcome=error");
  await dialog(page).getByRole("textbox").nth(0).fill("Command builder loses focus on Execute");
  await primary(page).click();
  await executed(page);
  await expect(dialog(page).getByText("Cannot reach GitHub", { exact: false })).toBeVisible();
  written.push(await snap(page, `17-forced-colors-error--daintree.png`, 3));
  await page.emulateMedia({ forcedColors: "none" });

  expect(pageErrors, `page errors: ${pageErrors.join(" | ")}`).toEqual([]);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(written.length).toBe(THEMES.length * 15 + 2);
  console.log(`[command-builder-shots] wrote ${written.length} captures to ${OUT_DIR}`);
});
