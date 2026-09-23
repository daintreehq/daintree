/**
 * Prompt history palette visual-review harness.
 *
 * The palette-family harness skips this palette: it only has rows once prompts
 * have been sent from an agent composer, and it only mounts inside a focused
 * `HybridInputBar`. So this drives its own preview entry
 * (`prompt-history-preview.html`): the real `PromptHistoryPalette` against the
 * real stores, tokens and `index.css`, with the history seeded from a fixture.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_PROMPTHISTORY=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots prompt-history-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PROMPTHISTORY  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR            required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES         comma-separated theme sweep (default daintree,bondi,namib)
 *
 * Hard rule, inherited from the siblings: never write a PNG that has not been
 * verified. Every capture proves the state it means to show is on screen first,
 * and the test counts the files itself rather than trusting the exit code.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_PROMPTHISTORY;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

test.use({ deviceScaleFactor: 2 });

const DIALOG = '[role="dialog"][aria-label="Prompt history search"]';
const VIEWPORT = { width: 1000, height: 900 };
const STATES_PER_THEME = 8;

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

const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

/**
 * Clip to the palette plus a margin, so the capture carries the surface edge,
 * its shadow and the scrim behind it. Throws rather than writing when the
 * dialog is not really on screen.
 */
async function snap(page: Page, dialog: Locator, file: string, pad = 40): Promise<string> {
  await expect(dialog).toBeAttached();
  const box = await dialog.boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: dialog has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    clip: {
      x,
      y,
      width: Math.min(box.width + pad * 2, VIEWPORT.width - x),
      height: Math.min(box.height + pad * 2, VIEWPORT.height - y),
    },
  });
  return out;
}

/** Load one fixture in one theme and settle it. */
async function open(page: Page, fixture: string, theme: string): Promise<Locator> {
  await page.setViewportSize(VIEWPORT);
  const url = `${server!.baseURL}/prompt-history-preview.html?theme=${theme}&fixture=${fixture}`;
  const dialog = page.locator(DIALOG).first();
  const timeout = 30_000;
  try {
    await page.goto(url);
    await expect(dialog).toBeAttached({ timeout });
  } catch {
    console.warn(`[prompt-history-shots] first mount of ${fixture}/${theme} failed; retrying once`);
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(dialog).toBeAttached({ timeout });
  }
  // Mounted is not styled: the command tier's width comes from a utility, so
  // its presence proves the stylesheet landed.
  await expect(dialog).toHaveCSS("width", "608px");
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return dialog;
}

function options(dialog: Locator): Locator {
  return dialog.getByRole("option");
}

function row(dialog: Locator, text: string | RegExp): Locator {
  return options(dialog).filter({ hasText: text });
}

async function selectedId(dialog: Locator): Promise<string | null> {
  const selected = dialog.locator('[role="option"][aria-selected="true"]');
  if ((await selected.count()) === 0) return null;
  return selected.first().getAttribute("id");
}

test("prompt history palette — states, interactions and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PROMPTHISTORY is required for the prompt-history capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_PROMPTHISTORY=1 to run the capture");
  test.setTimeout(600_000);

  await stubViteHmrClient(page);
  const written: string[] = [];
  const timeout = 10_000;

  for (const theme of THEMES) {
    // Browse, populated: the resting state with the first row selected.
    {
      const dialog = await open(page, "populated", theme);
      await expect(row(dialog, "fix the failing typecheck")).toBeVisible({ timeout });
      await expect(options(dialog)).toHaveCount(9);
      expect(await selectedId(dialog)).not.toBeNull();
      written.push(await snap(page, dialog, `populated--${theme}.png`));

      // Keyboard: walk the selection onto the single enormous line, so the
      // selected treatment has to carry a row that is also truncating.
      const before = await selectedId(dialog);
      const longRow = row(dialog, "Go through every forge provider");
      for (let i = 0; i < 6; i += 1) {
        if ((await longRow.getAttribute("aria-selected")) === "true") break;
        await page.keyboard.press("ArrowDown");
      }
      await page.waitForTimeout(150);
      const after = await selectedId(dialog);
      if (after === null || after === before) {
        throw new Error("ArrowDown did not move the selection — refusing to write");
      }
      await expect(longRow).toHaveAttribute("aria-selected", "true");
      written.push(await snap(page, dialog, `populated--${theme}--keyboard.png`));

      // Pointer: hovering a row moves the selection to it. The pointer is left
      // over the row so the hover and the selection are photographed together.
      const hovered = row(dialog, "audit every palette row");
      await hovered.hover({ position: { x: 60, y: 8 } });
      await expect(hovered).toHaveAttribute("aria-selected", "true");
      await expect(dialog.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
      await page.waitForTimeout(150);
      written.push(await snap(page, dialog, `populated--${theme}--hover.png`));
      await page.mouse.move(0, 0);

      // Search narrows the list and highlights what matched.
      await dialog.getByRole("combobox").fill("palette");
      await expect(row(dialog, "audit every palette row")).toBeVisible({ timeout });
      // The second "palette" sits ~60 characters into its prompt — past the
      // window a location-weighted search would look in.
      await expect(row(dialog, "palette store")).toBeVisible({ timeout });
      await expect(row(dialog, "fix the failing typecheck")).toHaveCount(0);
      await page.waitForTimeout(250);
      written.push(await snap(page, dialog, `populated--${theme}--search.png`));

      // A word deep inside the longest prompt: the row has to open on the match.
      await dialog.getByRole("combobox").fill("retry");
      const deep = row(dialog, "retry backoff");
      await expect(deep).toBeVisible({ timeout });
      const lead = await deep.evaluate((el) => el.textContent?.indexOf("retry") ?? -1);
      if (lead < 0 || lead > 60) {
        throw new Error(`deep match is not on screen (offset ${lead}) — refusing to write`);
      }
      await page.waitForTimeout(250);
      written.push(await snap(page, dialog, `populated--${theme}--search-deep.png`));

      // A search nothing matches.
      await dialog.getByRole("combobox").fill("kubernetes helm chart");
      await expect(options(dialog)).toHaveCount(0, { timeout });
      await page.waitForTimeout(250);
      written.push(await snap(page, dialog, `populated--${theme}--no-match.png`));
    }

    // All projects: the scope switch brings in another project's prompts.
    {
      const dialog = await open(page, "populated", theme);
      await expect(row(dialog, "fix the failing typecheck")).toBeVisible({ timeout });
      await expect(row(dialog, "Helios dashboard")).toHaveCount(0);
      await dialog.getByRole("button", { name: "All projects" }).click();
      await expect(dialog.getByRole("button", { name: "All projects" })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
      await expect(row(dialog, "Helios dashboard")).toBeVisible({ timeout });
      await page.waitForTimeout(150);
      written.push(await snap(page, dialog, `populated--${theme}--all-projects.png`));
    }

    // Nothing sent yet.
    {
      const dialog = await open(page, "empty", theme);
      await expect(dialog.getByText(/no .*history|no prompts/i).first()).toBeVisible({ timeout });
      await expect(options(dialog)).toHaveCount(0);
      written.push(await snap(page, dialog, `empty--${theme}.png`));
    }
  }

  // Count the files ourselves. A harness that trusts its own exit code is how a
  // review ends up reasoning about screenshots that were never written.
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * STATES_PER_THEME);
  console.log(`[prompt-history-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
