/**
 * Terminal Scratchpad visual-review harness.
 *
 * The Scratchpad is a notes column on the right of a terminal pane. Its states
 * are mostly things the user does to it — writing in it, dragging it narrow or
 * wide, hiding it with notes inside — so this drives its own preview entry
 * (`terminal-scratchpad-preview.html`), which mounts the REAL `ContentPanel`
 * and `TerminalScratchpad` against the real theme tokens and `index.css`.
 *
 *   DAINTREE_SHOT_SCRATCHPAD=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots terminal-scratchpad-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SCRATCHPAD  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR         required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES      theme sweep for the core states (default daintree,svalbard,namib,bondi)
 *
 * Never writes a PNG it has not verified: every capture asserts the state it
 * means to show is on screen, and the test counts the files at the end.
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_SCRATCHPAD;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,svalbard,namib,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

type Interaction =
  "rest" | "editing" | "resize-hover" | "resize-focus" | "hint-hover" | "hint-focus";

interface Shot {
  fixture: string;
  interaction: Interaction;
}

const PER_THEME: Shot[] = [
  { fixture: "empty", interaction: "rest" },
  { fixture: "empty", interaction: "editing" },
  { fixture: "notes", interaction: "rest" },
  { fixture: "notes", interaction: "editing" },
];

const DEFAULT_THEME_ONLY: Shot[] = [
  { fixture: "long", interaction: "editing" },
  { fixture: "narrow", interaction: "rest" },
  { fixture: "wide", interaction: "rest" },
  { fixture: "full", interaction: "rest" },
  { fixture: "collapsed", interaction: "rest" },
  { fixture: "notes", interaction: "resize-hover" },
  { fixture: "notes", interaction: "resize-focus" },
  { fixture: "notes", interaction: "hint-hover" },
  { fixture: "notes", interaction: "hint-focus" },
];

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

async function capture(page: Page, shot: Shot, theme: string): Promise<string> {
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: 1040, height: 640 });
  await page.goto(
    `${baseURL}/terminal-scratchpad-preview.html?theme=${theme}&fixture=${shot.fixture}`
  );
  const pane = page.locator(`[data-preview-pane="${shot.fixture}"]`);
  await expect(pane, `fixture "${shot.fixture}" rendered no pane`).toBeVisible();

  const column = page.getByTestId("terminal-scratchpad");
  const editor = page.getByTestId("terminal-scratchpad-editor");
  if (shot.fixture === "collapsed") {
    await expect(column).toHaveCount(0);
    await expect(page.getByTestId("panel-toggle-scratchpad")).toBeVisible();
  } else {
    await expect(column).toBeVisible();
    await expect(editor).toBeVisible();
  }

  switch (shot.interaction) {
    case "editing":
      await editor.click();
      await expect(editor).toBeFocused();
      break;
    case "resize-hover":
      await page.getByTestId("terminal-scratchpad-resize").hover();
      break;
    case "resize-focus":
      await page.getByTestId("terminal-scratchpad-resize").focus();
      await expect(page.getByTestId("terminal-scratchpad-resize")).toBeFocused();
      break;
    case "hint-hover":
      await page.getByTestId("terminal-scratchpad-status").getByText("Temporary").hover();
      await page.getByRole("tooltip").waitFor({ state: "attached" });
      break;
    case "hint-focus": {
      await page.mouse.move(1030, 630);
      const hint = page.getByTestId("terminal-scratchpad-status").locator("[tabindex='0']");
      await hint.focus();
      await expect(hint).toBeFocused();
      await page.getByRole("tooltip").waitFor({ state: "attached" });
      break;
    }
    case "rest":
      await page.mouse.move(1030, 630);
      break;
  }

  await page.evaluate(() => document.fonts.ready);
  // Hover and focus transitions, plus the separator's delayed grip width.
  await page.waitForTimeout(400);

  const box = await pane.boundingBox();
  if (!box || box.width < 100 || box.height < 100) {
    throw new Error(
      `${shot.fixture}-${shot.interaction}-${theme}: no real box — refusing to write`
    );
  }
  const out = path.join(OUT_DIR, `${shot.fixture}-${shot.interaction}-${theme}.png`);
  await pane.screenshot({ path: out });
  return out;
}

test("Terminal scratchpad — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SCRATCHPAD is required for the scratchpad capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_SCRATCHPAD=1 to run the capture");
  test.setTimeout(10 * 60_000);

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const theme of THEMES) {
    for (const shot of PER_THEME) written.push(await capture(page, shot, theme));
  }
  const defaultTheme = THEMES[0] ?? "daintree";
  for (const shot of DEFAULT_THEME_ONLY) written.push(await capture(page, shot, defaultTheme));

  expect(pageErrors, `page errors during capture:\n${pageErrors.join("\n")}`).toEqual([]);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(written.length).toBe(THEMES.length * PER_THEME.length + DEFAULT_THEME_ONLY.length);
});
