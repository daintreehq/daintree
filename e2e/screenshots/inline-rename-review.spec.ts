/**
 * Inline rename visual-review harness — the panel title field and the tab field.
 *
 * A pane names itself in two places: the header title (`PanelHeader`, driven by
 * `ContentPanel`) and, once it joins a group, its tab (`TabButton`). Both rename in
 * place, and both are meant to be one control. This drives the panel-header preview
 * and shoots each field from the pointer and from the keyboard, then where focus lands
 * once the rename ends:
 *
 *   {header|tab}--edit-pointer   double-click the name
 *   {header|tab}--edit-keyboard  Tab to the name, F2
 *   {header|tab}--after-enter    keyboard rename committed with Enter
 *   {header|tab}--after-escape   keyboard rename cancelled with Escape
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_RENAME is set.
 *
 *   DAINTREE_SHOT_RENAME=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots inline-rename-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_RENAME  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR     required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES  themes to sweep (default daintree,bondi,namib)
 *
 * Writes `focus.json` beside the PNGs: for every state, whether a rename field was
 * open and what held focus. Never writes a PNG it has not verified.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_RENAME;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

test.use({ deviceScaleFactor: 2 });

const STATES = ["edit-pointer", "edit-keyboard", "after-enter", "after-escape"] as const;
type RenameState = (typeof STATES)[number];

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
    if (file.endsWith(".png") || file === "focus.json") {
      rmSync(path.join(OUT_DIR, file), { force: true });
    }
  }
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function goto(page: Page, url: string, ready: Locator): Promise<void> {
  try {
    await page.goto(url);
    await expect(ready).toBeVisible({ timeout: 30_000 });
  } catch {
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(ready).toBeVisible({ timeout: 30_000 });
  }
  await expect(ready).toHaveCSS("display", "flex");
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

/** Tab from the top of the page until `target` holds focus. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  await page.mouse.move(0, 0);
  await page.locator("body").focus();
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error("Tab never reached the rename target — refusing to write");
}

interface Surface {
  name: "header" | "tab";
  load: (page: Page, theme: string) => Promise<{ region: Locator; name: Locator }>;
  field: (page: Page) => Locator;
}

const SURFACES: Surface[] = [
  {
    name: "header",
    load: async (page, theme) => {
      await page.setViewportSize({ width: 900, height: 300 });
      const pane = page.locator("[data-preview-pane]").first();
      const chrome = pane.locator("[data-pane-chrome]").first();
      await goto(
        page,
        `${server!.baseURL}/panel-header-preview.html?theme=${theme}&fixture=focused-working`,
        chrome
      );
      return { region: chrome, name: pane.getByRole("button", { name: /Claude/ }).first() };
    },
    field: (page) => page.locator("[data-testid='panel-title-edit-box'] input"),
  },
  {
    name: "tab",
    load: async (page, theme) => {
      await page.setViewportSize({ width: 900, height: 300 });
      const pane = page.locator("[data-preview-pane]").first();
      const strip = pane.getByRole("tablist");
      await goto(
        page,
        `${server!.baseURL}/panel-header-preview.html?theme=${theme}&fixture=tabs`,
        strip
      );
      await expect(strip.getByRole("tab")).toHaveCount(3);
      return {
        region: pane.locator("[data-pane-chrome]").first(),
        name: strip.getByRole("tab", { selected: true }),
      };
    },
    field: (page) => page.getByRole("textbox", { name: /^Rename tab/ }),
  },
];

interface FocusRecord {
  file: string;
  fieldOpen: boolean;
  fieldFocused: boolean;
  active: string;
}

async function describeFocus(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return "body";
    const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
    const label = el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? "";
    return `${role} "${label}"`;
  });
}

async function withPage<T>(context: BrowserContext, body: (page: Page) => Promise<T>): Promise<T> {
  const page = await context.newPage();
  await stubViteHmrClient(page);
  try {
    return await body(page);
  } finally {
    await page.close();
  }
}

test("inline rename — header and tab fields, pointer and keyboard, every theme", async ({
  context,
}) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_RENAME is required for the inline rename capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_RENAME=1 to run the capture");
  const snap = makeSnap(OUT_DIR);
  const written: string[] = [];
  const report: FocusRecord[] = [];

  for (const theme of THEMES) {
    for (const surface of SURFACES) {
      for (const state of STATES as readonly RenameState[]) {
        const file = `${surface.name}--${theme}--${state}.png`;
        written.push(
          await withPage(context, async (page) => {
            const { region, name } = await surface.load(page, theme);
            const field = surface.field(page);
            if (state === "edit-pointer") {
              await name.dblclick();
              await expect(field).toBeFocused();
              await field.fill("fix-auth-tets");
              await page.mouse.move(0, 0);
            } else {
              await tabTo(page, name);
              await page.keyboard.press("F2");
              // F2 is what is under review; if it opens nothing, the frame says so.
              const opened = await field
                .waitFor({ state: "visible", timeout: 1_000 })
                .then(() => true)
                .catch(() => false);
              if (state !== "edit-keyboard") {
                if (!opened) await name.dblclick();
                await expect(field).toBeFocused();
                await field.fill("fix-auth-tets");
                await page.keyboard.press(state === "after-enter" ? "Enter" : "Escape");
                await expect(field).toHaveCount(0);
              } else if (opened) {
                await field.pressSequentially("-v2");
              }
            }
            await page.waitForTimeout(250);
            const fieldOpen = (await field.count()) > 0;
            report.push({
              file,
              fieldOpen,
              fieldFocused:
                fieldOpen && (await field.evaluate((el) => el === document.activeElement)),
              active: await describeFocus(page),
            });
            return snap(region, file);
          })
        );
      }
    }
  }

  writeFileSync(path.join(OUT_DIR, "focus.json"), JSON.stringify(report, null, 2));
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(written.length).toBe(THEMES.length * SURFACES.length * STATES.length);
});
