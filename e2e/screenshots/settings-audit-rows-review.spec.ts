/**
 * Settings audit-log detail rows visual-review harness.
 *
 * The forge audit log's rows and the MCP latency-by-tool table only show their hard
 * cases (a long argument summary, an anomaly beside an error, namespaced tool ids that
 * differ only in their last segment, a narrow window) after weeks of real traffic, so
 * this drives their preview entry (`settings-audit-rows-preview.html`): the real
 * components, fed fixture records, inside a stand-in for the settings dialog body at
 * the dialog's real column widths.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_AUDITROWS is set.
 *
 *   DAINTREE_SHOT_AUDITROWS=1 DESIGN_CAPTURE_DIR=/abs/out \
 *     npx playwright test --project=screenshots settings-audit-rows-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_AUDITROWS  required: any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR       output directory (default artifacts/settings-audit-rows-shots)
 *   DAINTREE_SHOT_THEMES     comma-separated theme sweep (default: daintree,bondi)
 *
 * Never writes a PNG it has not verified: every state asserts the content it is meant
 * to show before it is photographed, and the test counts the files itself rather than
 * trusting the exit code.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_AUDITROWS;

/** The settings dialog's content column at its widest, and in an 800px window. */
const WIDE = 687;
const NARROW = 527;

const OUT_DIR = path.resolve(
  process.env.DESIGN_CAPTURE_DIR ??
    path.join(process.cwd(), "artifacts", "settings-audit-rows-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

test.use({ deviceScaleFactor: 2 });

let server: PreviewServer | undefined;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page, view: string, theme: string, width: number): Promise<Locator> {
  await page.setViewportSize({ width: width + 48, height: 1400 });
  const url = `${server!.baseURL}/settings-audit-rows-preview.html?theme=${theme}&view=${view}&width=${width}`;
  const group = page.locator("[data-preview-frame] .settings-card").first();
  try {
    await page.goto(url);
    await expect(group).toBeVisible({ timeout: 30_000 });
  } catch {
    console.warn(`[audit-rows-shots] first mount of ${view}/${theme}@${width} failed; retrying`);
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(group).toBeVisible({ timeout: 30_000 });
  }
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  return group;
}

async function showAllResults(page: Page): Promise<void> {
  await page.getByRole("combobox", { name: "Filter audit by result" }).click();
  await page.getByRole("option", { name: "All results" }).click();
  await expect(page.getByRole("combobox", { name: "Filter audit by result" })).toHaveText(
    /All results/
  );
  // The select hands focus back to its trigger, as a combobox should; the frame is
  // about the rows, so drop that ring rather than photograph the filter bar's state.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
}

/** What holds focus, for the sidecar: a frame alone can't say where a Tab landed. */
async function describeFocus(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return "body";
    const name = el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 60) ?? "";
    const inList = !!el.closest("ul");
    return `${el.tagName.toLowerCase()}${inList ? " (in list)" : ""}: ${name}`;
  });
}

test("settings audit rows: forge log and latency table across states, widths and themes", async ({
  page,
}) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_AUDITROWS is required for the audit-rows capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_AUDITROWS=1 to run the capture");

  await stubViteHmrClient(page);
  const snap = makeSnap(OUT_DIR);
  const written: string[] = [];
  const sidecar: Record<string, string> = {};
  const first = THEMES[0]!;

  for (const theme of THEMES) {
    {
      const group = await open(page, "forge", theme, WIDE);
      await expect(group.getByText("searchLinkedIssuesAcrossWorkspaces")).toBeVisible();
      await expect(group.getByText(/rate limit exceeded/)).toBeVisible();
      written.push(await snap(group, `forge-problems--${theme}.png`));
    }
    {
      const group = await open(page, "forge", theme, WIDE);
      await showAllResults(page);
      await expect(group.getByText("validateToken")).toBeAttached();
      written.push(await snap(group, `forge-all--${theme}.png`));
    }
    {
      const group = await open(page, "latency", theme, WIDE);
      await expect(group.getByRole("table")).toBeVisible();
      written.push(await snap(group, `latency--${theme}.png`));
    }
    {
      const group = await open(page, "latency", theme, NARROW);
      await expect(group.getByRole("table")).toBeVisible();
      written.push(await snap(group, `latency-narrow--${theme}.png`));
    }
  }

  {
    const group = await open(page, "forge", first, NARROW);
    await expect(group.getByText(/rate limit exceeded/)).toBeVisible();
    written.push(await snap(group, `forge-narrow--${first}.png`));
  }
  {
    const group = await open(page, "forge", first, WIDE);
    await showAllResults(page);
    await group.locator("ul").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(200);
    written.push(await snap(group, `forge-all-end--${first}.png`));
  }
  {
    // Keyboard: from the last filter, Tab the way a keyboard user would until focus
    // reaches the rows or passes them for the actions below.
    const group = await open(page, "forge", first, WIDE);
    await page.getByRole("combobox", { name: "Filter audit by time range" }).focus();
    // The scroll container takes a stop of its own; go past it to the first control
    // inside a row, or to the actions if the rows offer none.
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      const where = await describeFocus(page);
      if (/^button \(in list\)/.test(where) || /Refresh/.test(where)) break;
    }
    await page.waitForTimeout(250);
    sidecar[`forge-keyboard--${first}.png`] = await describeFocus(page);
    written.push(await snap(group, `forge-keyboard--${first}.png`));
  }
  {
    // The long argument summary opened in place, where the build offers a way to.
    const group = await open(page, "forge", first, WIDE);
    const more = group.getByRole("button", { name: "Show more" }).first();
    const hasToggle = (await more.count()) > 0;
    if (hasToggle) {
      await more.click();
      const less = group.getByRole("button", { name: "Show less" }).first();
      await expect(less).toBeVisible();
      // The opened summary runs past the list's 320px window; bring its end, and the
      // control that closes it, into view the way a reader would scroll to it.
      await less.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    }
    sidecar[`forge-expanded--${first}.png`] = hasToggle ? "expanded" : "no toggle";
    written.push(await snap(group, `forge-expanded--${first}.png`));
  }
  {
    const group = await open(page, "mcp", first, WIDE);
    await expect(group.getByText(/sendCommandMany/).first()).toBeVisible();
    written.push(await snap(group, `mcp-log--${first}.png`));
  }
  {
    const group = await open(page, "plugin", first, WIDE);
    await expect(group.getByText(/promoteReleaseCandidateToProduction/).first()).toBeVisible();
    written.push(await snap(group, `plugin-log--${first}.png`));
  }

  writeFileSync(path.join(OUT_DIR, "focus.json"), JSON.stringify(sidecar, null, 2));
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.sort()).toEqual(written.map((f) => path.basename(f)).sort());
  expect(onDisk.length).toBe(THEMES.length * 4 + 6);
  console.log(`[audit-rows-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
