/**
 * Event inspector detail header and context chips — visual-review harness.
 *
 * Drives `diagnostics-preview.html` on the Events tab: the real dock, the real
 * `EventDetail`, fed through the real event store and bridge. The detail pane
 * takes half the dock, so the window widths below put it at roughly 300, 400,
 * 600 and 900px. States that carry design weight: a long namespaced event name
 * with every context key carrying a long id, at every width; the ordinary
 * short event; the event name and a clipped chip hovered and keyboard-focused
 * at the narrowest width; the Metadata section open at that width; a chip that
 * is the active filter; and the long event across the theme sweep.
 *
 * Opt-in only: skips itself unless DESIGN_CAPTURE_DIR is set. That directory is
 * also the output — there is deliberately no in-repo default.
 *
 *   DESIGN_CAPTURE_DIR=/abs/out npx playwright test --project=screenshots event-detail-header-review
 *
 * Env knobs:
 *   DESIGN_CAPTURE_DIR     required — absolute output directory
 *   DAINTREE_SHOT_THEMES   comma-separated theme sweep (default daintree,bondi,namib,redwoods)
 *
 * Output: <state>--<width>--<theme>.png
 *
 * Never writes a PNG it has not verified, and counts the files at the end
 * rather than trusting the exit code.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const OUT = process.env.DESIGN_CAPTURE_DIR;
const ENABLED = !!OUT;

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib,redwoods")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const WIDTHS = [640, 800, 1200, 1800];
const NARROW = WIDTHS[0]!;
const DOCK_HEIGHT = 420;
const LONG_TYPE = "agent:lifecycle:approval-requested:waiting-for-tool-permission";
const LONG_WORKTREE = "wt-feature-event-inspector-narrow-dock-header-layout";
const LONG_AGENT = "claude-opus-7f3a91c2-4b1e-4d0a-9c3e-2f1b8a6d5e40";
const ATTACH_TIMEOUT_MS = 30_000;

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;

test.beforeAll(async () => {
  if (!ENABLED) return;
  mkdirSync(OUT!, { recursive: true });
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function withPage(
  context: BrowserContext,
  what: string,
  body: (page: Page) => Promise<void>
): Promise<void> {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await stubViteHmrClient(page);
    await body(page);
    if (errors.length > 0) throw new Error(`${what}: page threw: ${errors.join(" | ")}`);
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** The dock plus room below it, so a tooltip opening off the bottom edge is in frame. */
async function snap(page: Page, dock: Locator, file: string): Promise<void> {
  await expect(dock).toBeVisible();
  const box = await dock.boundingBox();
  if (!box || box.width < 200 || Math.abs(box.height - DOCK_HEIGHT) > 2) {
    throw new Error(`${file}: dock has the wrong box (${JSON.stringify(box)}) — refusing to write`);
  }
  await page.screenshot({
    path: path.join(OUT!, file),
    clip: { x: box.x, y: box.y, width: box.width, height: box.height + 140 },
    animations: "disabled",
  });
}

async function openDock(
  page: Page,
  fixture: string,
  theme: string,
  width: number,
  { foldPayload }: { foldPayload: boolean }
): Promise<{ dock: Locator; detail: Locator }> {
  await page.setViewportSize({ width, height: DOCK_HEIGHT * 2 + 40 + 160 });
  for (let attempt = 0; ; attempt++) {
    await page.goto(
      `${server!.baseURL}/diagnostics-preview.html?fixture=${fixture}&theme=${theme}&height=${DOCK_HEIGHT}&width=${width}`
    );
    try {
      await expect(page.locator(".diagnostics-dock").first()).toBeAttached({
        timeout: ATTACH_TIMEOUT_MS,
      });
      break;
    } catch (error) {
      if (attempt >= 2) throw new Error(`${fixture} ${theme} never rendered`, { cause: error });
    }
  }
  const dock = page.locator(".diagnostics-dock").first();
  const copy = dock.getByRole("button", { name: "Copy payload JSON" });
  await expect(copy, `${fixture}: no event selected`).toBeVisible({ timeout: ATTACH_TIMEOUT_MS });
  const detail = copy.locator("xpath=ancestor::div[contains(@class,'h-full')][1]");
  if (foldPayload) {
    await detail.getByRole("button", { name: "Payload", exact: true }).click();
  }
  const context = detail.getByRole("button", { name: "Context", exact: true });
  if ((await context.getAttribute("aria-expanded")) !== "true") await context.click();
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(350);
  return { dock, detail };
}

function chip(detail: Locator, value: string): Locator {
  return detail.locator("button[aria-pressed]", { hasText: value.slice(0, 12) }).first();
}

test("event detail header — widths, long names, chips", async ({ browser }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DESIGN_CAPTURE_DIR is required for the event detail header capture",
  });
  test.skip(!ENABLED, "Set DESIGN_CAPTURE_DIR to run the event detail header capture");
  test.setTimeout(10 * 60_000);
  const context = await browser.newContext({ deviceScaleFactor: 2, reducedMotion: "reduce" });
  const expected: string[] = [];
  const [first] = THEMES;

  for (const width of WIDTHS) {
    await withPage(context, `long ${width}`, async (page) => {
      const { dock, detail } = await openDock(page, "events-long", first!, width, {
        foldPayload: true,
      });
      await expect(detail.getByText(LONG_TYPE.slice(0, 20)).first()).toBeVisible();
      await expect(chip(detail, LONG_AGENT)).toBeVisible();
      const file = `long--${width}--${first}.png`;
      await snap(page, dock, file);
      expected.push(file);
    });
  }

  for (const width of [800, 1200]) {
    await withPage(context, `short ${width}`, async (page) => {
      const { dock } = await openDock(page, "events-populated", first!, width, {
        foldPayload: false,
      });
      const file = `short--${width}--${first}.png`;
      await snap(page, dock, file);
      expected.push(file);
    });
  }

  await withPage(context, "filtered", async (page) => {
    const { dock, detail } = await openDock(page, "events-long-filtered", first!, 800, {
      foldPayload: true,
    });
    await expect(chip(detail, LONG_WORKTREE)).toHaveAttribute("aria-pressed", "true");
    const file = `filtered--800--${first}.png`;
    await snap(page, dock, file);
    expected.push(file);
  });

  // Hover and keyboard focus at the narrowest dock: the event name, then a
  // clipped chip. Whatever discloses the full value must show up in frame.
  await withPage(context, "probes", async (page) => {
    const { dock, detail } = await openDock(page, "events-long", first!, NARROW, {
      foldPayload: true,
    });
    const title = detail.locator("h3").first();
    await title.hover();
    await page.waitForTimeout(900);
    const file = `title-hover--${NARROW}--${first}.png`;
    await snap(page, dock, file);
    expected.push(file);
  });

  await withPage(context, "chip probes", async (page) => {
    const { dock, detail } = await openDock(page, "events-long", first!, NARROW, {
      foldPayload: true,
    });
    const agent = chip(detail, LONG_AGENT);
    await agent.hover();
    await page.waitForTimeout(900);
    let file = `chip-hover--${NARROW}--${first}.png`;
    await snap(page, dock, file);
    expected.push(file);

    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);
    await page.keyboard.press("Tab");
    await agent.focus();
    await page.waitForTimeout(900);
    const focusVisible = await agent.evaluate((el) => el.matches(":focus-visible"));
    if (!focusVisible) throw new Error("chip-focus: chip is not :focus-visible");
    file = `chip-focus--${NARROW}--${first}.png`;
    await snap(page, dock, file);
    expected.push(file);
  });

  // Title reveal, then an ordinary pointer move onto a chip on the same page:
  // the second reveal must still open.
  await withPage(context, "sequential", async (page) => {
    const { dock, detail } = await openDock(page, "events-long", first!, NARROW, {
      foldPayload: true,
    });
    const title = detail.locator("h3").first();
    await title.hover();
    await page.waitForTimeout(900);
    const box = await chip(detail, LONG_AGENT).boundingBox();
    if (!box) throw new Error("sequential: agent chip has no box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
    // The outgoing tooltip is still fading over the chip when the pointer
    // lands; a real pointer keeps moving, and the next move opens this one.
    await page.waitForTimeout(200);
    await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2);
    await page.waitForTimeout(900);
    const file = `title-then-chip--${NARROW}--${first}.png`;
    await snap(page, dock, file);
    expected.push(file);
  });

  for (const [mode, media] of [
    ["forced", { forcedColors: "active" }],
    ["contrast", { contrast: "more" }],
  ] as const) {
    await withPage(context, mode, async (page) => {
      await page.emulateMedia(media);
      const { dock, detail } = await openDock(page, "events-long-filtered", first!, NARROW, {
        foldPayload: true,
      });
      const agent = chip(detail, LONG_AGENT);
      await page.keyboard.press("Tab");
      await agent.focus();
      await page.waitForTimeout(900);
      const file = `${mode}-focus--${NARROW}--${first}.png`;
      await snap(page, dock, file);
      expected.push(file);
    });
  }

  await withPage(context, "metadata", async (page) => {
    const { dock, detail } = await openDock(page, "events-long", first!, NARROW, {
      foldPayload: true,
    });
    await detail.getByRole("button", { name: "Metadata", exact: true }).click();
    await detail.getByText("Trace ID:").scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const file = `metadata--${NARROW}--${first}.png`;
    await snap(page, dock, file);
    expected.push(file);
  });

  for (const theme of THEMES.slice(1)) {
    await withPage(context, `theme ${theme}`, async (page) => {
      const { dock } = await openDock(page, "events-long", theme, 800, { foldPayload: true });
      const file = `long--800--${theme}.png`;
      await snap(page, dock, file);
      expected.push(file);
    });
  }

  await context.close();

  const written = new Set(readdirSync(OUT!).filter((f) => f.endsWith(".png")));
  const missing = expected.filter((f) => !written.has(f) || !existsSync(path.join(OUT!, f)));
  expect(missing, `missing captures: ${missing.join(", ")}`).toEqual([]);
  console.log(`[event-detail-header-shots] wrote ${expected.length} PNGs to ${OUT}`);
});
