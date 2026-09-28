/**
 * Document tab strips visual-review harness — the four strips as one family.
 *
 * Daintree draws "a row of documents, one of them open" in four places: a grid pane's
 * tab group (`PanelHeader` → `TabButton`), a docked tab group's popover
 * (`DockedTabGroup` → `TabButton`), the portal's browser tabs (`PortalToolbar`) and the
 * assistant's session lanes (`HelpSessionTabs`). They are meant to look and behave as
 * one control, and the only way to judge that is to see them side by side in the same
 * states, so this drives each surface's existing preview entry rather than booting
 * Electron, and shoots the same four states in each:
 *
 *   rest            the selected tab beside unselected ones
 *   hover           the pointer over an unselected tab — its close control appears
 *   focus           keyboard focus on the selected tab, reached with real Tab presses
 *   arrow           one ArrowRight from there — shows the activation model
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_DOCTABS is set.
 *
 *   DAINTREE_SHOT_DOCTABS=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots document-tabs-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_DOCTABS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR      required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES   themes to sweep (default daintree,bondi,namib)
 *
 * Never writes a PNG it has not verified, and counts the files itself at the end.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_DOCTABS;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

test.use({ deviceScaleFactor: 2 });

const STATES = ["rest", "hover", "focus", "arrow"] as const;
type StripState = (typeof STATES)[number];

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

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

async function goto(page: Page, url: string, ready: Locator): Promise<void> {
  try {
    await page.goto(url);
    await expect(ready).toBeVisible({ timeout: 30_000 });
  } catch {
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(ready).toBeVisible({ timeout: 30_000 });
  }
  // Mounted is not styled: `flex` is a Tailwind utility, so it proves the sheet landed.
  await expect(ready).toHaveCSS("display", "flex");
  await settle(page);
}

/** Tab from the top of the page until focus lands on a tab inside `strip`. */
async function tabInto(page: Page, strip: Locator): Promise<void> {
  await page.mouse.move(0, 0);
  await page.locator("body").focus();
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press("Tab");
    const inside = await strip.evaluate(
      (el) => el.contains(document.activeElement) && document.activeElement?.role === "tab"
    );
    if (inside) return;
  }
  throw new Error("Tab never reached a tab in the strip — refusing to write");
}

interface Surface {
  name: string;
  /** Load the surface; returns the tablist and the region to photograph. */
  load: (page: Page, theme: string) => Promise<{ strip: Locator; region: Locator }>;
  /** An unselected tab to hover. */
  hoverTarget: (strip: Locator) => Locator;
}

const SURFACES: Surface[] = [
  {
    name: "grid",
    load: async (page, theme) => {
      await page.setViewportSize({ width: 900, height: 400 });
      const pane = page.locator("[data-preview-pane]").first();
      const strip = pane.getByRole("tablist");
      await goto(
        page,
        `${server!.baseURL}/panel-header-preview.html?theme=${theme}&fixture=tabs`,
        strip
      );
      await expect(strip.getByRole("tab")).toHaveCount(3);
      return { strip, region: pane.locator("[data-pane-chrome]").first() };
    },
    hoverTarget: (strip) => strip.getByRole("tab", { name: /write funnel tests/ }),
  },
  {
    name: "dock",
    load: async (page, theme) => {
      await page.setViewportSize({ width: 1440, height: 700 });
      const shell = page.locator("[data-preview-shell]").first();
      await goto(
        page,
        `${server!.baseURL}/dock-preview.html?theme=${theme}&fixture=busy&width=1440&density=normal&open=p-g1`,
        shell
      );
      await page.waitForTimeout(300);
      // `open=p-g1` opens the docked tab group's popover, which holds the strip.
      const strip = page
        .getByRole("tablist")
        .filter({ has: page.getByRole("tab", { name: /zsh/ }) })
        .first();
      await expect(strip).toBeVisible();
      await expect(strip.getByRole("tab")).toHaveCount(2);
      await page.mouse.move(0, 0);
      await page.waitForTimeout(300);
      // The strip's own row — the popover's header band.
      const region = strip.locator("xpath=ancestor::*[contains(@class,'border-b')][1]");
      return { strip, region: (await region.count()) > 0 ? region.first() : strip };
    },
    hoverTarget: (strip) => strip.getByRole("tab", { name: /zsh/ }),
  },
  {
    name: "portal",
    load: async (page, theme) => {
      await page.setViewportSize({ width: 560, height: 500 });
      const strip = page.getByRole("tablist", { name: "Portal tabs" });
      await goto(
        page,
        `${server!.baseURL}/portal-preview.html?theme=${theme}&fixture=page-active`,
        strip
      );
      await expect(strip.getByRole("tab")).toHaveCount(3);
      const region = strip.locator("xpath=ancestor::*[contains(@class,'border-b')][1]");
      return { strip, region: region.first() };
    },
    hoverTarget: (strip) => strip.getByRole("tab").filter({ hasNotText: "zzz" }).nth(1),
  },
  {
    name: "help",
    load: async (page, theme) => {
      await page.setViewportSize({ width: 420, height: 130 });
      const strip = page.getByRole("tablist", { name: "Assistant sessions" });
      await goto(
        page,
        `${server!.baseURL}/session-tabs-preview.html?theme=${theme}&fixture=three-mixed&width=380`,
        strip
      );
      await expect(strip.getByRole("tab")).toHaveCount(3);
      return { strip, region: page.locator("[data-preview-panel]").first() };
    },
    hoverTarget: (strip) => strip.getByRole("tab").nth(1),
  },
];

async function withPage<T>(context: BrowserContext, body: (page: Page) => Promise<T>): Promise<T> {
  const page = await context.newPage();
  await stubViteHmrClient(page);
  try {
    return await body(page);
  } finally {
    await page.close();
  }
}

test("document tab strips — four surfaces, four states, every theme", async ({ context }) => {
  test.skip(!ENABLED, "set DAINTREE_SHOT_DOCTABS=1 to run the capture");
  const snap = makeSnap(OUT_DIR);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const surface of SURFACES) {
      for (const state of STATES as readonly StripState[]) {
        written.push(
          await withPage(context, async (page) => {
            const { strip, region } = await surface.load(page, theme);
            if (state === "hover") {
              await surface.hoverTarget(strip).hover();
              await page.waitForTimeout(200);
            } else if (state === "focus" || state === "arrow") {
              await tabInto(page, strip);
              const focusedSelected = await page.evaluate(
                () => document.activeElement?.getAttribute("aria-selected") === "true"
              );
              if (!focusedSelected) {
                throw new Error(
                  `${surface.name}: Tab landed on an unselected tab — refusing to write`
                );
              }
              if (state === "arrow") {
                await page.keyboard.press("ArrowRight");
                await page.waitForTimeout(200);
                const moved = await strip.evaluate((el) => {
                  const tabs = [...el.querySelectorAll('[role="tab"]')];
                  return tabs.indexOf(document.activeElement as Element) > 0;
                });
                if (!moved) {
                  throw new Error(
                    `${surface.name}: ArrowRight did not move focus — refusing to write`
                  );
                }
              }
              await page.waitForTimeout(150);
            }
            return snap(region, `${surface.name}--${theme}--${state}.png`);
          })
        );
      }
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(written.length).toBe(THEMES.length * SURFACES.length * STATES.length);
});
