/**
 * Dev-server indicator visual-review harness.
 *
 * The indicator sits in the worktree card header's trailing mark group and
 * reports a worktree's dev server: starting or installing, running on a port,
 * or failed. This drives the preview entry (`worktree-dev-server-preview.html`),
 * which mounts the REAL `WorktreeHeader` in the sidebar card's chrome with one
 * dev-preview session per row, so every state is judged beside the pin,
 * external and agent marks it shares the group with. A live dev server in the
 * Electron app cannot be pinned to `starting` or to a chosen error, which is
 * why this is a preview page.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_DEV_SERVER=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     npx playwright test --project=screenshots dev-server-indicator-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_DEV_SERVER  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR        output directory (default artifacts/dev-server-shots)
 *   DAINTREE_SHOT_THEMES      comma-separated theme sweep (default daintree,bondi,namib,svalbard)
 *
 * Never writes a PNG it has not verified: every page asserts each row's
 * indicator reached the status its fixture was built for (the startup rows
 * only appear past the Doherty gate), the tooltip shots assert the tooltip's
 * text, and the test counts the files itself.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient, makeSnap } from "../helpers/previewHarness";

test.use({ deviceScaleFactor: 2 });

const ENABLED = !!process.env.DAINTREE_SHOT_DEV_SERVER;

const OUT_DIR = path.resolve(
  process.env.DESIGN_CAPTURE_DIR ?? path.join(process.cwd(), "artifacts", "dev-server-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib,svalbard")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** One dark and one light theme carry the tooltip and contrast shots. */
const FOCUS_THEMES = ["daintree", "bondi"];

type Fixture = "sidebar" | "collapsed";

/** Each preview row and the status its indicator must report before a shot. */
const EXPECTED: Record<string, string> = {
  running: "running",
  "running-agent": "running",
  starting: "starting",
  installing: "installing",
  "error-port": "error",
  "error-raw": "error",
};

const TOOLTIP_ROWS = [
  { row: "running", text: /localhost:5173/ },
  { row: "starting", text: /Starting/ },
  { row: "installing", text: /Installing/ },
  { row: "error-port", text: /5173/ },
  { row: "error-raw", text: /dev server/i },
] as const;

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";
let snap: ReturnType<typeof makeSnap>;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
  baseURL = server.baseURL;
  snap = makeSnap(OUT_DIR);
});

test.afterAll(async () => {
  await server?.close();
});

const indicatorOf = (page: Page, row: string) =>
  page.locator(`[data-preview-row="${row}"]`).getByTestId("dev-server-indicator");

async function open(page: Page, fixture: Fixture, theme: string) {
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: 800, height: 900 });
  await page.mouse.move(0, 0);
  await page.goto(
    `${baseURL}/worktree-dev-server-preview.html?${new URLSearchParams({ theme, fixture })}`
  );
  const card = page.locator("[data-preview-card]");
  await expect(card, `fixture "${fixture}" rendered nothing`).toBeVisible();
  for (const [row, status] of Object.entries(EXPECTED)) {
    await expect(indicatorOf(page, row), `${fixture}/${row}: indicator missing`).toHaveAttribute(
      "data-dev-server-status",
      status,
      { timeout: 5_000 }
    );
  }
  await page.evaluate(() => document.fonts.ready);
  // Run every animation to its end frame, so a looping startup mark is the
  // same frame every run and a tooltip's entry fade never photographs mid-way.
  await page.addStyleTag({
    content:
      "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; }",
  });
  await page.waitForTimeout(250);
  return card;
}

/** The top-right of the list, where each header's trailing group sits. */
async function rowClip(page: Page, row: string) {
  const header = page.locator(`[data-preview-row="${row}"]`);
  const box = await header.boundingBox();
  if (!box) throw new Error(`${row}: row has no box`);
  return box;
}

test("Dev-server indicator — states, themes, tooltips", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_DEV_SERVER is required for the dev-server indicator capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_DEV_SERVER=1 to run the capture");

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const theme of THEMES) {
    written.push(await snap(await open(page, "sidebar", theme), `sidebar-${theme}.png`));
    written.push(await snap(await open(page, "collapsed", theme), `collapsed-${theme}.png`));
  }

  for (const theme of FOCUS_THEMES) {
    for (const { row, text } of TOOLTIP_ROWS) {
      await open(page, "sidebar", theme);
      await indicatorOf(page, row).hover();
      const tip = page.getByRole("tooltip");
      await expect(tip, `${row}: tooltip never opened`).toContainText(text);
      await page.waitForTimeout(400);
      const rb = await rowClip(page, row);
      const tb = await page
        .locator("[data-radix-popper-content-wrapper]")
        .filter({ visible: true })
        .last()
        .boundingBox();
      if (!tb) throw new Error(`${row}: tooltip has no box`);
      const x = Math.max(0, Math.min(rb.x, tb.x) - 12);
      const y = Math.max(0, Math.min(rb.y, tb.y) - 12);
      const right = Math.max(rb.x + rb.width, tb.x + tb.width) + 12;
      const bottom = Math.max(rb.y + rb.height, tb.y + tb.height) + 12;
      const file = `tooltip-${row}-${theme}.png`;
      await page.screenshot({
        path: path.join(OUT_DIR, file),
        clip: { x, y, width: right - x, height: bottom - y },
      });
      written.push(file);
    }

    await page.emulateMedia({ forcedColors: "active" });
    written.push(
      await snap(await open(page, "sidebar", theme), `sidebar-${theme}-forced-colors.png`)
    );
    await page.emulateMedia({ forcedColors: "none" });
  }

  expect(pageErrors, `preview page threw: ${pageErrors.join(" | ")}`).toEqual([]);

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  console.log(`[dev-server-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
