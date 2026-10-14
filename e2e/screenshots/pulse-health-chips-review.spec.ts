/**
 * Project Pulse health-chip strip visual-review harness.
 *
 * Drives the strip's preview entry (`pulse-health-chips-preview.html`), which
 * mounts the REAL `PulseHealthSignals` inside the pulse card's own frame once
 * per fixture: all healthy, CI failing, security alerts, CI pending, zero
 * counts, four-digit counts, a long prerelease tag, a year-old release, no
 * releases. A real session reaches most of those rarely and none of them on
 * demand.
 *
 *   DESIGN_CAPTURE_DIR=/abs/out npx playwright test --project=screenshots pulse-health-chips-review
 *
 * Env knobs:
 *   DESIGN_CAPTURE_DIR       required — absolute output directory
 *   DAINTREE_SHOT_THEMES     anchor themes, every width (default daintree,bondi)
 *   DAINTREE_SHOT_SWEEP      themes that get the mixed-state sheet only
 *                            (default namib,svalbard,redwoods,table-mountain)
 *
 * Output: <dir>/chips--<state>--<theme>.png. Never writes a frame it has not
 * verified, and counts the files itself at the end.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient, makeSnap } from "../helpers/previewHarness";

const OUT = process.env.DESIGN_CAPTURE_DIR ?? "";

function list(value: string | undefined, fallback: string[]): string[] {
  if (value === "none") return [];
  const parsed = (value ?? "").split(",").filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

const THEMES = list(process.env.DAINTREE_SHOT_THEMES, ["daintree", "bondi"]);
const SWEEP = list(process.env.DAINTREE_SHOT_SWEEP, [
  "namib",
  "svalbard",
  "redwoods",
  "table-mountain",
]);

/** Mirrors `FIXTURES` in the preview entry, which only resolves under Vite. */
const FIXTURES = [
  "healthy",
  "ci-failing",
  "security",
  "pending",
  "zero",
  "large",
  "long-release",
  "old-release",
  "no-release",
];
const WIDTHS = { narrow: 300, medium: 480, wide: 760 } as const;
const MIXED = "healthy,security,long-release";

test.use({ deviceScaleFactor: 2 });

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";
let snap: ReturnType<typeof makeSnap>;

test.beforeAll(async () => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  server = await startPreviewServer();
  baseURL = server.baseURL;
  snap = makeSnap(OUT);
});

test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page, theme: string, width: number, only?: string): Promise<void> {
  await stubViteHmrClient(page);
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: width + 120, height: 3400 });
  const q = new URLSearchParams({ theme, width: String(width) });
  if (only) q.set("only", only);
  await page.goto(`${baseURL}/pulse-health-chips-preview.html?${q.toString()}`);
  const expected = only ? only.split(",").length : FIXTURES.length;
  await expect(page.locator("[data-fixture]"), "wrong fixture count").toHaveCount(expected);
  await expect(page.locator(".pulse-card").first().locator("button").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

test("Pulse health chips — states, widths and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DESIGN_CAPTURE_DIR is required for the pulse-health-chips capture",
  });
  test.skip(!OUT, "Set DESIGN_CAPTURE_DIR to run the pulse-health-chips capture");
  if (!path.isAbsolute(OUT)) throw new Error("DESIGN_CAPTURE_DIR must be an absolute path");

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const shell = () => page.locator("[data-preview-shell]");

  for (const theme of THEMES) {
    for (const [name, width] of Object.entries(WIDTHS)) {
      await open(page, theme, width);
      written.push(await snap(shell(), `chips--sheet-${name}--${theme}.png`));
    }

    // Keyboard focus on the issues chip: tabbed into, so it is :focus-visible.
    await open(page, theme, WIDTHS.medium, "healthy");
    await page
      .locator(".pulse-card")
      .first()
      .click({ position: { x: 4, y: 4 } });
    let reached = false;
    for (let press = 0; press < 6 && !reached; press += 1) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() =>
        /issue/i.test(
          document.activeElement?.getAttribute("aria-label") ??
            document.activeElement?.textContent ??
            ""
        )
      );
    }
    if (!reached) throw new Error("Tab never reached the issues chip");
    await page.waitForTimeout(250);
    written.push(await snap(shell(), `chips--focus-issues--${theme}.png`));

    // Hover on the release chip, held long enough for any tooltip to open.
    await open(page, theme, WIDTHS.narrow, "long-release");
    const release = page.locator(".pulse-card button", { hasText: "v12" }).first();
    await expect(release, "no release chip").toBeVisible();
    await release.hover();
    await page.waitForTimeout(900);
    {
      const box = await shell().boundingBox();
      if (!box) throw new Error("hover-release: shell has no box");
      const out = path.join(OUT, `chips--hover-release--${theme}.png`);
      await page.screenshot({
        path: out,
        clip: { x: box.x, y: box.y, width: box.width + 100, height: box.height + 90 },
      });
      written.push(out);
    }
  }

  for (const theme of SWEEP) {
    await open(page, theme, WIDTHS.medium, MIXED);
    written.push(await snap(shell(), `chips--sweep-mixed--${theme}.png`));
  }

  expect(pageErrors, `page errors during capture:\n${pageErrors.join("\n")}`).toEqual([]);
  for (const file of written) expect(existsSync(file), `${file} missing`).toBe(true);
  const onDisk = readdirSync(OUT).filter((f) => f.startsWith("chips--") && f.endsWith(".png"));
  expect(onDisk.length).toBe(THEMES.length * 5 + SWEEP.length);
});
