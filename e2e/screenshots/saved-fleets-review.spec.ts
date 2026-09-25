/**
 * Saved fleets visual-review harness.
 *
 * Saved fleets are listed and recalled from the bottom of the fleet ribbon's selection
 * menu, which only exists once two or more panes are armed. Every state worth judging —
 * frecency-ranked snapshots, a partly-gone snapshot, a stale one kept for cleanup, live
 * rules, the save dialog in each mode, the delete confirm, and the cold-start picker's
 * quick recall — needs a populated
 * `fleetSavedScopes` and an open menu, so this drives the Fleet preview entry
 * (`fleet-preview.html`) rather than booting Electron: the real `FleetArmingRibbon` and
 * `SavedFleetsSection`, seeded through the real Zustand stores, against the real theme
 * tokens.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_SAVED_FLEETS=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots saved-fleets-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SAVED_FLEETS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR           required — output directory, outside the repo
 *   DAINTREE_SHOT_THEMES        comma-separated sweep (default: daintree,bondi,namib)
 *
 * The first theme gets every state; the others get the SWEEP subset.
 *
 * Hard rule, inherited from the sibling harnesses: never write a PNG that has not been
 * verified. Every capture asserts its state's marker is really on screen first and
 * throws otherwise, and the test counts the files itself at the end.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_SAVED_FLEETS;

const OUT_DIR = process.env.DAINTREE_SHOT_DIR ? path.resolve(process.env.DAINTREE_SHOT_DIR) : "";

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const FRAME_WIDTH = 1100;
const FRAME_HEIGHT = 900;

const MENU = '[role="menu"]';

let server: ViteDevServer | undefined;
let baseURL = "";

test.use({ deviceScaleFactor: 2, screenshot: "off" });

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!OUT_DIR) throw new Error("DAINTREE_SHOT_DIR must be set to a directory outside the repo");
  const repo = path.resolve(process.cwd());
  if (
    OUT_DIR === path.parse(OUT_DIR).root ||
    repo === OUT_DIR ||
    repo.startsWith(OUT_DIR + path.sep)
  ) {
    throw new Error(`DAINTREE_SHOT_DIR (${OUT_DIR}) contains the checkout — refusing`);
  }
  if (OUT_DIR.startsWith(repo + path.sep)) {
    throw new Error(`DAINTREE_SHOT_DIR (${OUT_DIR}) is inside the checkout — refusing`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  for (const f of readdirSync(OUT_DIR)) {
    if (f.endsWith(".png")) rmSync(path.join(OUT_DIR, f), { force: true });
  }

  // Same server setup as fleet-ribbon-review: a free port, and the symlinked
  // node_modules allowed so fonts load in a worktree.
  const nodeModules = realpathSync(path.join(process.cwd(), "node_modules"));
  server = await createServer({
    server: { port: 0, strictPort: false, fs: { allow: [process.cwd(), nodeModules] } },
    logLevel: "error",
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("vite gave no TCP address");
  baseURL = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await server?.close();
});

/** Inert `@vite/client` — see fleet-ribbon-review for why a live one blanks pages. */
async function stubViteHmrClient(page: Page): Promise<void> {
  await page.route("**/@vite/client", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: [
        "const noop = () => {};",
        "export const createHotContext = () => ({ accept: noop, acceptExports: noop, dispose: noop, prune: noop, decline: noop, invalidate: noop, on: noop, off: noop, send: noop, data: {} });",
        "export const injectQuery = (u) => u;",
        "const sheets = new Map();",
        "export function updateStyle(id, content) {",
        "  let style = sheets.get(id);",
        "  if (!style) {",
        "    style = document.createElement('style');",
        "    style.setAttribute('type', 'text/css');",
        "    style.setAttribute('data-vite-dev-id', id);",
        "    style.textContent = content;",
        "    document.head.appendChild(style);",
        "    sheets.set(id, style);",
        "  } else {",
        "    style.textContent = content;",
        "  }",
        "}",
        "export function removeStyle(id) {",
        "  const style = sheets.get(id);",
        "  if (style) { document.head.removeChild(style); sheets.delete(id); }",
        "}",
      ].join("\n"),
    })
  );
}

type Clip = { x: number; y: number; width: number; height: number };

/**
 * The menu plus the ribbon it hangs from: wide enough to show the trigger's
 * neighbours, tall enough to include the whole menu, and nothing below it.
 */
async function menuClip(frame: Locator, menu: Locator): Promise<Clip> {
  const f = await frame.boundingBox();
  const m = await menu.boundingBox();
  if (!f || !m) throw new Error("menu or frame has no box — refusing to write");
  const x = Math.max(f.x, m.x - 360);
  const bottom = Math.min(f.y + f.height, m.y + m.height + 24);
  return { x, y: f.y, width: f.x + f.width - x, height: bottom - f.y };
}

async function snap(page: Page, clip: Clip, marker: Locator, file: string): Promise<string> {
  await expect(marker, `${file}: marker not visible — refusing to write`).toBeVisible();
  if (clip.width < 8 || clip.height < 8) {
    throw new Error(`${file}: clip has no real box (${JSON.stringify(clip)}) — refusing to write`);
  }
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, clip });
  return out;
}

async function open(page: Page, fixture: string, theme: string): Promise<Locator> {
  await page.setViewportSize({ width: FRAME_WIDTH, height: FRAME_HEIGHT });
  const url = `${baseURL}/fleet-preview.html?theme=${theme}&fixture=${fixture}&width=${FRAME_WIDTH}&height=${FRAME_HEIGHT}`;
  const frame = page.locator("[data-preview-frame]").first();
  const timeout = 30_000;
  try {
    await page.goto(url);
    await expect(frame).toBeAttached({ timeout });
  } catch {
    console.warn(`[saved-fleets-shots] first mount of ${fixture}/${theme} failed; retrying once`);
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(frame).toBeAttached({ timeout });
  }
  await expect(frame).toHaveCSS("display", "flex");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  return frame;
}

async function openMenu(page: Page): Promise<Locator> {
  await page.getByTestId("fleet-selection-menu-trigger").click();
  const menu = page.locator(MENU).first();
  await expect(menu).toBeVisible();
  // Overlay entry motion.
  await page.waitForTimeout(300);
  return menu;
}

interface Shot {
  name: string;
  fixture: string;
  sweep?: boolean;
  /** Drive the open menu into the state; return the marker to verify. */
  drive: (page: Page, menu: Locator) => Promise<Locator>;
  /** Photograph the whole frame instead of the menu region (dialogs). */
  fullFrame?: boolean;
  /** The state lives outside the selection menu; don't open it. */
  noMenu?: boolean;
}

const SHOTS: Shot[] = [
  {
    name: "menu-rich",
    fixture: "saved-rich",
    sweep: true,
    drive: async (page) => page.getByTestId("fleet-saved-row").first(),
  },
  {
    name: "menu-empty",
    fixture: "saved-empty",
    drive: async (page) => page.getByTestId("fleet-save-open"),
  },
  {
    name: "menu-dense",
    fixture: "saved-dense",
    drive: async (page) => page.getByTestId("fleet-saved-row").nth(9),
  },
  {
    name: "row-hover",
    fixture: "saved-rich",
    drive: async (page) => {
      const row = page.getByTestId("fleet-saved-row").first();
      await row.hover();
      await page.waitForTimeout(250);
      return row;
    },
  },
  {
    name: "row-keyboard-stale",
    fixture: "saved-rich",
    drive: async (page) => {
      // Walk the menu with the keyboard until the stale snapshot holds focus, so
      // the ring is a real `:focus-visible` rather than a hover decoration.
      await page.mouse.move(0, FRAME_HEIGHT - 1);
      let reached = false;
      for (let i = 0; i < 20 && !reached; i += 1) {
        await page.keyboard.press("ArrowDown");
        await page.waitForTimeout(60);
        reached = await page.evaluate(() => {
          const el = document.activeElement;
          return (
            el?.getAttribute("data-testid") === "fleet-saved-row" &&
            el.getAttribute("data-stale") === "true"
          );
        });
      }
      if (!reached) throw new Error("keyboard never reached the stale row — refusing to write");
      await page.waitForTimeout(250);
      return page.locator('[data-testid="fleet-saved-row"][data-stale="true"]').first();
    },
  },
  {
    name: "delete-confirm",
    fixture: "saved-rich",
    fullFrame: true,
    drive: async (page) => {
      // Delete on a focused row is the menu's accelerator to the confirm.
      const row = page.getByTestId("fleet-saved-row").first();
      await row.focus();
      await page.keyboard.press("Delete");
      const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog")).first();
      await expect(dialog).toBeVisible();
      await page.waitForTimeout(350);
      return dialog;
    },
  },
  {
    name: "manage-dialog",
    fixture: "saved-rich",
    sweep: true,
    fullFrame: true,
    drive: async (page) => {
      await page.getByTestId("fleet-saved-manage-open").click();
      const dialog = page.getByTestId("fleet-saved-manage-dialog");
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId("fleet-saved-manage-row")).toHaveCount(6);
      await page.waitForTimeout(300);
      return dialog;
    },
  },
  {
    name: "save-dialog",
    fixture: "saved-rich",
    fullFrame: true,
    drive: async (page) => {
      await page.getByTestId("fleet-save-open").click();
      const dialog = page.getByTestId("fleet-save-dialog");
      await expect(dialog).toBeVisible();
      await page.waitForTimeout(300);
      await page.keyboard.type("Morning triage");
      await expect(page.getByTestId("fleet-save-form-name")).toHaveValue("Morning triage");
      return dialog;
    },
  },
  {
    name: "save-dialog-rule",
    fixture: "saved-rich",
    sweep: true,
    fullFrame: true,
    drive: async (page) => {
      await page.getByTestId("fleet-save-open").click();
      const dialog = page.getByTestId("fleet-save-dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("radio", { name: "Live rule" }).click();
      await page.waitForTimeout(300);
      return dialog.getByTestId("fleet-save-rule-state");
    },
  },
  {
    name: "palette-recall",
    fixture: "saved-palette",
    sweep: true,
    fullFrame: true,
    noMenu: true,
    drive: async (page) => page.getByTestId("fleet-picker-saved-fleets"),
  },
];

test("saved fleets — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SAVED_FLEETS is required for the saved fleets capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_SAVED_FLEETS=1 to run the capture");

  await stubViteHmrClient(page);
  const written: string[] = [];

  for (const [index, theme] of THEMES.entries()) {
    const shots = index === 0 ? SHOTS : SHOTS.filter((s) => s.sweep);
    for (const shot of shots) {
      const frame = await open(page, shot.fixture, theme);
      const menu = shot.noMenu ? page.locator(MENU).first() : await openMenu(page);
      const marker = await shot.drive(page, menu);
      let clip: Clip;
      if (shot.fullFrame) {
        const box = await frame.boundingBox();
        if (!box) throw new Error(`${shot.name}: frame has no box — refusing to write`);
        clip = box;
      } else {
        clip = await menuClip(frame, page.locator(MENU).first());
      }
      written.push(await snap(page, clip, marker, `${shot.name}--${theme}.png`));
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(
    SHOTS.length + (THEMES.length - 1) * SHOTS.filter((s) => s.sweep).length
  );
  console.log(`[saved-fleets-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
