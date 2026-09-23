/**
 * Terminal artifact overlay visual-review harness.
 *
 * The overlay lists what an agent produced in one terminal — code, patches, a
 * summary — and can apply a patch behind a confirm. Reaching its states in the
 * running app means an agent emitting exactly the right blocks, then a patch
 * that fails to apply on cue, so this drives the preview entry
 * (`artifact-overlay-preview.html`) instead: the real `ArtifactOverlay` in a box
 * the size of a pane's xterm host, fed through its own `artifact.onDetected`
 * subscription, with apply and save answered by the shimmed bridge.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_ARTIFACTS=1 npx playwright test --project=screenshots artifact-overlay-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_ARTIFACTS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR        output directory (default artifacts/artifact-overlay-shots)
 *   DAINTREE_SHOT_THEMES     comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Output: `<state>-<theme>.png`. Hard rule, inherited from the siblings: never
 * write a PNG that has not been verified. Every state asserts the thing it is
 * named for is on screen after the settle, `snap()` refuses a target with no
 * real box, and the test counts the files itself at the end.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { makeSnap, startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_ARTIFACTS;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "artifact-overlay-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const PANE = { width: 760, height: 520 };
const NARROW_PANE = { width: 440, height: 520 };
const DIALOG_VIEWPORT = { width: 1100, height: 820 };
const ATTACH_TIMEOUT_MS = 20_000;

let baseURL = "";
let closeServer: (() => Promise<void>) | undefined;
const snap = makeSnap(OUT_DIR);

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const server = await startPreviewServer();
  baseURL = server.baseURL;
  closeServer = server.close;
});

test.afterAll(async () => {
  await closeServer?.();
});

interface OpenOptions {
  fixture?: string;
  theme: string;
  pane?: { width: number; height: number };
  viewport?: { width: number; height: number };
  apply?: "success" | "error";
  save?: "success" | "error";
  worktree?: boolean;
}

async function withPage<T>(
  context: BrowserContext,
  what: string,
  body: (page: Page) => Promise<T>
): Promise<T> {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await stubViteHmrClient(page);
    const result = await body(page);
    if (errors.length > 0) throw new Error(`${what}: page threw: ${errors.join(" | ")}`);
    return result;
  } catch (error) {
    throw new Error(`${what}: ${String(error)}`, { cause: error });
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function settle(page: Page, ms = 300) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
}

/** Load the pane in one state and return its shell, with the collapsed trigger proven present. */
async function openPane(page: Page, opts: OpenOptions): Promise<Locator> {
  const pane = opts.pane ?? PANE;
  await page.setViewportSize(opts.viewport ?? { width: pane.width + 48, height: pane.height + 48 });
  const query = new URLSearchParams({
    theme: opts.theme,
    fixture: opts.fixture ?? "populated",
    width: String(pane.width),
    height: String(pane.height),
    apply: opts.apply ?? "success",
    save: opts.save ?? "success",
    worktree: opts.worktree === false ? "0" : "1",
  });
  await page.goto(`${baseURL}/artifact-overlay-preview.html?${query.toString()}`);
  const shell = page.locator("[data-preview-shell]").first();
  await expect(shell).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  // No trigger means the fixture never reached the store, and the overlay
  // rendered null — a picture of a bare terminal passing as the resting state.
  await expect(page.locator("[data-artifact-trigger]")).toBeVisible();
  await settle(page);
  return shell;
}

async function expandPanel(page: Page) {
  await page.locator("[data-artifact-trigger]").click();
  await expect(page.locator("[data-artifact-panel]")).toBeVisible();
}

function item(page: Page, id: string): Locator {
  return page.locator(`[data-artifact-item="${id}"]`);
}

async function expandItem(page: Page, id: string) {
  const row = item(page, id);
  await row.getByRole("button").first().click();
  await expect(row.getByRole("button", { name: /copy/i })).toBeVisible();
}

async function openApplyConfirm(page: Page, id: string) {
  await expandItem(page, id);
  await item(page, id).getByRole("button", { name: /apply/i }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

async function confirmApply(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: /^apply/i })
    .last()
    .click();
  await expect(dialog).toBeHidden();
}

test("terminal artifact overlay — every state, every theme", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_ARTIFACTS is required for the artifact overlay capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_ARTIFACTS=1 to run the capture");

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const written: string[] = [];

  for (const theme of THEMES) {
    const shot = async (name: string, body: (page: Page) => Promise<Locator>) => {
      written.push(
        await withPage(context, `${name} ${theme}`, async (page) =>
          snap(await body(page), `${name}-${theme}.png`)
        )
      );
    };

    await shot("pill", (page) => openPane(page, { theme }));

    await shot("open", async (page) => {
      const shell = await openPane(page, { theme });
      await expandPanel(page);
      await settle(page);
      return shell;
    });

    await shot("open-patch", async (page) => {
      const shell = await openPane(page, { theme });
      await expandPanel(page);
      await expandItem(page, "patch-2");
      await settle(page);
      return shell;
    });

    await shot("open-code", async (page) => {
      const shell = await openPane(page, { theme });
      await expandPanel(page);
      await expandItem(page, "code-1");
      await settle(page);
      return shell;
    });

    await shot("copied", async (page) => {
      const shell = await openPane(page, { theme });
      await expandPanel(page);
      await expandItem(page, "code-1");
      await item(page, "code-1").getByRole("button", { name: /copy/i }).click();
      await expect(item(page, "code-1").getByRole("status")).toContainText(/copied/i);
      await page.waitForTimeout(120);
      return shell;
    });

    await shot("confirm-single", async (page) => {
      await openPane(page, { theme, viewport: DIALOG_VIEWPORT });
      await expandPanel(page);
      await openApplyConfirm(page, "patch-2");
      await expect(page.getByRole("dialog")).toContainText("markDirty");
      await settle(page);
      return page.locator("body");
    });

    await shot("apply-success", async (page) => {
      const shell = await openPane(page, { theme });
      await expandPanel(page);
      await openApplyConfirm(page, "patch-2");
      await confirmApply(page);
      await expect(item(page, "patch-2").getByRole("status")).toContainText(/applied/i);
      await page.waitForTimeout(120);
      return shell;
    });

    await shot("apply-error", async (page) => {
      const shell = await openPane(page, { theme, apply: "error" });
      await expandPanel(page);
      await openApplyConfirm(page, "patch-2");
      await confirmApply(page);
      await expect(page.locator("[data-artifact-panel]")).toContainText(/does not apply/i);
      await page.waitForTimeout(120);
      return shell;
    });

    await shot("confirm-bulk", async (page) => {
      await openPane(page, { theme, viewport: DIALOG_VIEWPORT });
      await expandPanel(page);
      await page
        .locator("[data-artifact-panel]")
        .getByRole("button", { name: /apply (all|2)/i })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("formatBytes");
      await expect(dialog).toContainText("markDirty");
      await settle(page);
      return page.locator("body");
    });

    await shot("many", async (page) => {
      const shell = await openPane(page, { theme, fixture: "many" });
      await expandPanel(page);
      await expect(page.locator("[data-artifact-item]")).toHaveCount(16);
      await settle(page);
      return shell;
    });

    await shot("long-patch-open", async (page) => {
      const shell = await openPane(page, { theme, fixture: "long-patch" });
      await expandPanel(page);
      await expandItem(page, "patch-long");
      await settle(page);
      return shell;
    });

    await shot("long-patch-confirm", async (page) => {
      await openPane(page, { theme, fixture: "long-patch", viewport: DIALOG_VIEWPORT });
      await expandPanel(page);
      await openApplyConfirm(page, "patch-long");
      await expect(page.getByRole("dialog")).toContainText("ShortcutGroup0");
      await settle(page);
      return page.locator("body");
    });

    await shot("single-code", async (page) => {
      const shell = await openPane(page, { theme, fixture: "single-code" });
      await expandPanel(page);
      await settle(page);
      return shell;
    });

    await shot("narrow", async (page) => {
      const shell = await openPane(page, { theme, pane: NARROW_PANE });
      await expandPanel(page);
      await expandItem(page, "patch-2");
      await settle(page);
      return shell;
    });

    await shot("no-worktree", async (page) => {
      const shell = await openPane(page, { theme, fixture: "single-patch", worktree: false });
      await expandPanel(page);
      await expandItem(page, "patch-2");
      await settle(page);
      return shell;
    });

    await shot("focus-trigger", async (page) => {
      const shell = await openPane(page, { theme });
      await page.locator("[data-artifact-trigger]").focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(page.locator("[data-artifact-trigger]")).toBeFocused();
      await settle(page, 200);
      return shell;
    });
  }

  // Count the files ourselves. A harness that trusts its own exit code is how a
  // review ends up reasoning about screenshots that were never written.
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * 16);
  console.log(`[artifact-overlay-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
