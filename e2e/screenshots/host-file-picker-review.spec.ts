/**
 * Host file picker visual-review harness.
 *
 * Drives the picker preview entry (`host-file-picker-preview.html`) — the real
 * `HostFilePickerDialog` over a fixture filesystem served through the bridge
 * calls the app makes — and captures its states: folder and file modes,
 * selection and keyboard focus, multi-select, a deep path on a long host
 * name, long filenames, a slow navigation, an empty folder and a refusal.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_HOST_PICKER=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots host-file-picker-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_HOST_PICKER  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          required — output directory, outside the repo
 *   DAINTREE_SHOT_THEMES       comma-separated theme sweep (default: daintree,svalbard)
 *
 * Output: `<state>-<theme>.png` per state and theme. Never writes a PNG it has
 * not verified, and counts the files itself rather than trusting the exit code.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_HOST_PICKER;
const ATTACH_TIMEOUT_MS = 30_000;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ? path.resolve(process.env.DAINTREE_SHOT_DIR) : "";

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,svalbard")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const LONG_PDF = "2026-10-14 quarterly infrastructure migration plan — final review copy v3.pdf";

interface State {
  name: string;
  scenario: string;
  /** Drives the dialog into the state and asserts it is there before the capture. */
  drive(page: Page, dialog: Locator): Promise<void>;
}

const option = (dialog: Locator, name: string) =>
  dialog.getByRole("option", { name: new RegExp(`^${escapeRegex(name)}`) });

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function populated(dialog: Locator) {
  await expect(dialog.getByRole("option").first()).toBeVisible();
}

const STATES: State[] = [
  {
    name: "folder-rest",
    scenario: "folder",
    drive: async (_page, dialog) => populated(dialog),
  },
  {
    name: "folder-selected-hover",
    scenario: "folder",
    drive: async (page, dialog) => {
      await populated(dialog);
      await option(dialog, "daintree").first().click();
      await expect(option(dialog, "daintree").first()).toHaveAttribute("aria-selected", "true");
      await option(dialog, "togoer-web").hover();
      await page.waitForTimeout(150);
    },
  },
  {
    name: "folder-keyboard",
    scenario: "folder",
    drive: async (page, dialog) => {
      await populated(dialog);
      await dialog.getByRole("textbox").first().focus();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press(" ");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await expect(dialog.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
      await page.mouse.move(0, 0);
    },
  },
  {
    name: "folder-deep-long-host",
    scenario: "folder-deep",
    drive: async (_page, dialog) => {
      await populated(dialog);
      await expect(option(dialog, "snapshots")).toBeVisible();
    },
  },
  {
    name: "folder-deep-crumbs",
    scenario: "folder-deep",
    drive: async (page, dialog) => {
      await populated(dialog);
      await option(dialog, "snapshots").click();
      await expect(dialog.getByRole("navigation", { name: "Folder path" })).toBeVisible();
      await page.mouse.move(0, 0);
    },
  },
  {
    name: "folder-loading-slow",
    scenario: "folder",
    drive: async (page, dialog) => {
      await populated(dialog);
      await option(dialog, "pagesugar").dblclick();
      await page.waitForTimeout(1_600);
      await expect(dialog.locator('[aria-busy="true"]')).toHaveCount(1);
      await page.mouse.move(0, 0);
    },
  },
  {
    name: "folder-empty",
    scenario: "folder-empty",
    drive: async (_page, dialog) => {
      await expect(dialog.getByRole("listbox")).toBeVisible();
      await expect(dialog.getByRole("option")).toHaveCount(0);
      await expect(dialog.getByRole("listbox")).not.toHaveAttribute("aria-busy", "true");
    },
  },
  {
    name: "folder-error",
    scenario: "folder-error",
    drive: async (_page, dialog) => {
      await expect(dialog.getByText(/Permission denied/).first()).toBeVisible();
    },
  },
  {
    name: "file-rest",
    scenario: "file-multi",
    drive: async (_page, dialog) => populated(dialog),
  },
  {
    name: "file-long-selected",
    scenario: "file",
    drive: async (page, dialog) => {
      await populated(dialog);
      await option(dialog, LONG_PDF).click();
      await expect(option(dialog, LONG_PDF)).toHaveAttribute("aria-selected", "true");
      await page.mouse.move(0, 0);
    },
  },
  {
    name: "file-long-tooltip",
    scenario: "file",
    drive: async (page, dialog) => {
      await populated(dialog);
      const row = option(dialog, "customer-onboarding");
      await row.hover();
      await expect(row).toBeVisible();
      // Long enough for the tooltip delay; whether a reveal shows is what the capture is for.
      await page.waitForTimeout(900);
    },
  },
  {
    name: "file-multi",
    scenario: "file-multi",
    drive: async (page, dialog) => {
      await populated(dialog);
      await option(dialog, "design-review-notes.md").click();
      await option(dialog, "meeting-notes.txt").click({ modifiers: ["ControlOrMeta"] });
      await option(dialog, "release-checklist.md").click({ modifiers: ["ControlOrMeta"] });
      await expect(dialog.locator('[role="option"][aria-selected="true"]')).toHaveCount(3);
      await page.mouse.move(0, 0);
    },
  },
];

let server: ViteDevServer | undefined;
let baseURL = "";
const ENTRY = "/src/components/HostFilePicker/__preview__/hostFilePickerPreview.tsx";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!OUT_DIR) throw new Error("DAINTREE_SHOT_DIR must name an output directory outside the repo");
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "warn" });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("vite gave no TCP address");
  baseURL = `http://127.0.0.1:${address.port}`;
  await server.warmupRequest(ENTRY);
});

test.afterAll(async () => {
  await server?.close();
});

/** Hold one page open until Vite's dependency optimizer stops force-reloading it. */
async function settleDevServer(context: BrowserContext) {
  const page = await context.newPage();
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  await page.goto(`${baseURL}/host-file-picker-preview.html?scenario=folder`);
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const dialogs = await page.locator('[role="dialog"]').count();
    if (navigations === before && dialogs === 1) break;
  }
  await page.close();
}

async function snap(target: Locator, file: string): Promise<string> {
  await expect(target).toBeAttached();
  const box = await target.boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: target has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const out = path.join(OUT_DIR, file);
  await target.screenshot({ path: out });
  return out;
}

/** A fresh page per capture; one renderer crash under load gets one retry. */
async function withPage<T>(
  context: BrowserContext,
  what: string,
  body: (page: Page) => Promise<T>
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const page = await context.newPage();
    let crashed = false;
    const errors: string[] = [];
    page.on("crash", () => {
      crashed = true;
    });
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      const result = await body(page);
      if (errors.length > 0) throw new Error(`${what}: page threw: ${errors.join(" | ")}`);
      return result;
    } catch (error) {
      if (crashed && attempt === 1) continue;
      throw new Error(`${what}: ${String(error)}`, { cause: error });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

test("host file picker — modes, selection, long names, loading, empty, error", async ({
  context,
}) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_HOST_PICKER is required for the host file picker capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_HOST_PICKER=1 to run the capture");
  test.setTimeout(240_000);

  await settleDevServer(context);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const state of STATES) {
      written.push(
        await withPage(context, `${state.name} ${theme}`, async (page) => {
          await page.setViewportSize({ width: 1100, height: 820 });
          await page.goto(
            `${baseURL}/host-file-picker-preview.html?theme=${theme}&scenario=${state.scenario}`
          );
          const dialog = page.locator('[role="dialog"]').first();
          await expect(dialog).toBeVisible({ timeout: ATTACH_TIMEOUT_MS });
          await page.evaluate(() => document.fonts.ready);
          await state.drive(page, dialog);
          await page.waitForTimeout(250);
          return snap(page.locator("body"), `${state.name}-${theme}.png`);
        })
      );
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * STATES.length);
  console.log(`[host-file-picker-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
