/**
 * Send-to-agent palette visual-review harness.
 *
 * The palette-family harness skips this palette: it only opens from a live
 * terminal selection with another PTY pane to receive it. So this drives its
 * own preview entry (`send-to-agent-preview.html`): the real
 * `SendToAgentPalette` and its real hook against the real panel and worktree
 * stores, tokens and `index.css`, with the panes seeded from a fixture.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_SENDTOAGENT=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots send-to-agent-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SENDTOAGENT  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES       comma-separated theme sweep (default daintree,bondi,namib)
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

const ENABLED = !!process.env.DAINTREE_SHOT_SENDTOAGENT;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

test.use({ deviceScaleFactor: 2 });

const DIALOG = '[role="dialog"][aria-label="Send text to a terminal"]';
const VIEWPORT = { width: 900, height: 800 };
const STATES_PER_THEME = 9;

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
  const url = `${server!.baseURL}/send-to-agent-preview.html?theme=${theme}&fixture=${fixture}`;
  const dialog = page.locator(DIALOG).first();
  const timeout = 30_000;
  try {
    await page.goto(url);
    await expect(dialog).toBeAttached({ timeout });
  } catch {
    console.warn(`[send-to-agent-shots] first mount of ${fixture}/${theme} failed; retrying once`);
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(dialog).toBeAttached({ timeout });
  }
  // Mounted is not styled: the anchored tier's width comes from a utility, so
  // its presence proves the stylesheet landed.
  await expect(dialog).toHaveCSS("width", "484px");
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

test("send-to-agent palette — states, interactions and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SENDTOAGENT is required for the send-to-agent capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_SENDTOAGENT=1 to run the capture");
  test.setTimeout(600_000);

  await stubViteHmrClient(page);
  page.on("pageerror", (err) => console.error(`[send-to-agent-shots] page error: ${err.message}`));
  const written: string[] = [];
  const timeout = 10_000;

  for (const theme of THEMES) {
    // One worktree: the resting state, first target selected.
    {
      const dialog = await open(page, "mixed", theme);
      await expect(row(dialog, "fix auth token refresh tests")).toBeVisible({ timeout });
      await expect(options(dialog)).toHaveCount(5);
      expect(await selectedId(dialog)).toBe("send-to-agent-option-t-1");
      written.push(await snap(page, dialog, `mixed--${theme}.png`));

      // Keyboard: walk past the locked row, so the capture shows where the
      // cursor lands and how the locked row reads beside it.
      for (let i = 0; i < 2; i += 1) await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(150);
      const after = await selectedId(dialog);
      if (after === null || after === "send-to-agent-option-t-1") {
        throw new Error("ArrowDown did not move the selection — refusing to write");
      }
      written.push(await snap(page, dialog, `mixed--${theme}--keyboard.png`));

      // Pointer over a selectable row.
      const shell = row(dialog, /^Terminal/);
      await shell.hover({ position: { x: 80, y: 10 } });
      await page.waitForTimeout(150);
      written.push(await snap(page, dialog, `mixed--${theme}--hover.png`));

      // Pointer over the locked row.
      const locked = row(dialog, "draft the release notes");
      await expect(locked).toHaveAttribute("aria-disabled", "true");
      await locked.hover({ position: { x: 80, y: 10 } });
      await page.waitForTimeout(150);
      written.push(await snap(page, dialog, `mixed--${theme}--hover-locked.png`));
      await page.mouse.move(0, 0);
    }

    // Three worktrees: every row names its worktree.
    {
      const dialog = await open(page, "worktrees", theme);
      await expect(row(dialog, "oauth-device-flow").first()).toBeVisible({ timeout });
      await expect(row(dialog, "streaming-token-refresh").first()).toBeVisible({ timeout });
      written.push(await snap(page, dialog, `worktrees--${theme}.png`));

      // Search by worktree.
      await dialog.getByRole("combobox").fill("oauth");
      await expect(row(dialog, "oauth-device-flow").first()).toBeVisible({ timeout });
      await expect(row(dialog, /^Terminal/)).toHaveCount(0);
      await page.waitForTimeout(250);
      written.push(await snap(page, dialog, `worktrees--${theme}--search.png`));

      // A search nothing matches.
      await dialog.getByRole("combobox").fill("kubernetes helm chart");
      await expect(options(dialog)).toHaveCount(0, { timeout });
      await page.waitForTimeout(250);
      written.push(await snap(page, dialog, `worktrees--${theme}--no-match.png`));
    }

    // Every target locked.
    {
      const dialog = await open(page, "all-locked", theme);
      await expect(options(dialog)).toHaveCount(2, { timeout });
      await expect(options(dialog).first()).toHaveAttribute("aria-disabled", "true");
      written.push(await snap(page, dialog, `all-locked--${theme}.png`));
    }

    // The last target closed while the palette was open.
    {
      const dialog = await open(page, "empty", theme);
      await expect(dialog.getByText(/no other terminals|create/i).first()).toBeVisible({
        timeout,
      });
      await expect(options(dialog)).toHaveCount(0);
      written.push(await snap(page, dialog, `empty--${theme}.png`));
    }
  }

  // Count the files ourselves. A harness that trusts its own exit code is how a
  // review ends up reasoning about screenshots that were never written.
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * STATES_PER_THEME);
  console.log(`[send-to-agent-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
