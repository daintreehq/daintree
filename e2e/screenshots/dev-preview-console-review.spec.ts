/**
 * Dev preview console visual-review harness — stack traces.
 *
 * Every stack trace in the console belongs to a guest page that threw, warned or
 * traced, so none of these states can be held still in the app. This drives the
 * preview entry (`dev-preview-console-preview.html`), which mounts the real
 * `ConsolePanel` and feeds it rows through the real store ingest, then expands
 * traces with real clicks and performs focus and hover with real keys and a
 * real pointer.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_DEVCONSOLE is set.
 *
 *   DAINTREE_SHOT_DEVCONSOLE=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots dev-preview-console-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_DEVCONSOLE   required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES       themes for the per-state captures (default daintree,namib,svalbard)
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { BUILT_IN_THEME_SOURCES } from "@shared/theme/builtInThemeSources";
import {
  CONSOLE_FIXTURES,
  CONSOLE_FIXTURE_NAMES,
  type ConsoleFixtureName,
  type ConsoleStackFixture,
} from "../../src/components/DevPreview/__preview__/consoleFixtures";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_DEVCONSOLE;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,namib,svalbard")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const ALL_THEMES = BUILT_IN_THEME_SOURCES.map((t) => t.id);

test.use({ deviceScaleFactor: 2 });

const FRAME = "[data-fixture]";

const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
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
    if (file.endsWith(".png")) rmSync(path.join(OUT_DIR, file), { force: true });
  }
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

/** Every row that carries a stack, in DOM order — one disclosure each. */
function stackToggles(page: Page): Locator {
  return page.locator(FRAME).getByRole("button", { name: /stack trace/i });
}

async function open(page: Page, name: ConsoleFixtureName, theme: string): Promise<Locator> {
  const fixture: ConsoleStackFixture = CONSOLE_FIXTURES[name];
  await page.setViewportSize({ width: fixture.width + 80, height: fixture.height + 80 });
  await stubViteHmrClient(page);
  await page.mouse.move(0, 0);
  page.removeAllListeners("pageerror");
  page.on("pageerror", (error) => console.warn(`[dev-console-shots] pageerror: ${error.message}`));
  const url = `${server!.baseURL}/dev-preview-console-preview.html?theme=${theme}&fixture=${name}`;
  const frame = page.locator(FRAME).first();
  try {
    await page.goto(url);
    await expect(frame).toBeAttached({ timeout: 30_000 });
  } catch {
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(frame).toBeAttached({ timeout: 30_000 });
  }
  // The console toolbar's filter buttons prove the panel mounted and styled.
  await expect(page.getByRole("button", { name: /^Errors/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^All/ })).toHaveCSS("border-radius", /px/);
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  return frame;
}

/** The rendered row for a fixture row, found by its own message text. */
function rowFor(page: Page, fixture: ConsoleStackFixture, index: number): Locator {
  const row = fixture.rows[index]!;
  const first = row.args[0];
  const text =
    first && first.type === "primitive" ? String(first.value) : row.summaryText.split("\n")[0]!;
  return page.locator(`${FRAME} [class~="group/row"]`).filter({ hasText: text }).first();
}

function toggleIn(row: Locator): Locator {
  return row.getByRole("button", { name: /stack trace/i }).first();
}

/**
 * Expansion is component state, so it is performed with real clicks. A row
 * may open on its own (an uncaught exception's stack), so a toggle already
 * expanded is left alone rather than clicked shut.
 */
async function expandRows(page: Page, fixture: ConsoleStackFixture): Promise<void> {
  for (const index of fixture.expand ?? []) {
    const toggle = toggleIn(rowFor(page, fixture, index));
    await expect(toggle, `row ${index} offers no stack trace`).toBeVisible();
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    const first = fixture.rows[index]!.stackTrace!.callFrames[0]!;
    await expect(
      rowFor(page, fixture, index)
        .getByText(first.functionName || "(anonymous)", { exact: true })
        .first()
    ).toBeVisible();
  }
  await page.mouse.move(0, 0);
}

async function drive(page: Page, fixture: ConsoleStackFixture): Promise<void> {
  switch (fixture.drive) {
    case "keyboard-focus": {
      const target = stackToggles(page).last();
      await expect(target).toBeVisible();
      for (
        let i = 0;
        i < 40 && !(await target.evaluate((el) => el === document.activeElement));
        i++
      ) {
        await page.keyboard.press("Tab");
      }
      await expect(target).toBeFocused();
      break;
    }
    case "object-open": {
      await page.getByRole("button", { name: /ORC-114/ }).click();
      await expect(page.locator(FRAME).getByText("sku", { exact: true })).toBeVisible();
      await page.mouse.move(0, 0);
      break;
    }
    case "row-focus": {
      // Keyboard focus on the row itself swaps the short source for the full path.
      const row = rowFor(page, fixture, 1);
      for (let i = 0; i < 20 && !(await row.evaluate((el) => el === document.activeElement)); i++) {
        await page.keyboard.press("Tab");
      }
      await expect(row).toBeFocused();
      break;
    }
    case "hover-toggle": {
      // The warning row: a disclosure in every revision of the console.
      await toggleIn(rowFor(page, fixture, 2)).hover();
      break;
    }
    default:
      break;
  }
  await page.waitForTimeout(150);
}

/** What each fixture must show before its PNG is written. */
async function expectFixtureState(page: Page, fixture: ConsoleStackFixture): Promise<void> {
  await expect(page.locator(`${FRAME} [class~="group/row"]`)).toHaveCount(fixture.rows.length);
  for (const index of fixture.expand ?? []) {
    const last = fixture.rows[index]!.stackTrace!.callFrames.at(-1)!;
    await expect(
      rowFor(page, fixture, index)
        .getByText(last.functionName || "(anonymous)", { exact: true })
        .last()
    ).toBeAttached();
  }
}

test("Dev preview console — stack traces", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_DEVCONSOLE is required for the dev preview console capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_DEVCONSOLE=1 to run the capture");
  test.setTimeout(15 * 60_000);

  const unknown = THEMES.filter((theme) => !ALL_THEMES.includes(theme));
  if (unknown.length > 0) {
    // The preview falls back to the default theme for a name it does not know,
    // which would write a correctly named PNG of the wrong theme.
    throw new Error(`Unknown theme(s) in DAINTREE_SHOT_THEMES: ${unknown.join(", ")}`);
  }

  const snap = makeSnap(OUT_DIR);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const name of CONSOLE_FIXTURE_NAMES) {
      const fixture: ConsoleStackFixture = CONSOLE_FIXTURES[name];
      const frame = await open(page, name, theme);
      await expandRows(page, fixture);
      await drive(page, fixture);
      await expectFixtureState(page, fixture);
      written.push(await snap(frame, `${name}--${theme}.png`));
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * CONSOLE_FIXTURE_NAMES.length);
  console.log(`[dev-console-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
