/**
 * Cross-worktree compare dialog visual-review harness.
 *
 * `CrossWorktreeDiff` only has anything to show once two real branches have
 * really diverged — the file list, the churn counts, the split diff and the
 * "no differences" state are all computed by git from committed history. So
 * the fixture commits a realistic change set onto one branch (added, modified,
 * deleted and renamed files, two files sharing a basename, a prose file, a
 * deep path) and drives the real dialog through the real card menu.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_COMPARE is set, so the
 * marketing screenshots workflow never executes it.
 *
 *   DAINTREE_SHOT_COMPARE=1 npx playwright test --project=screenshots cross-worktree-diff-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_COMPARE  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME    optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG      optional suffix so theme sweeps sit side by side
 *   DAINTREE_SHOT_ONLY     comma-separated step filter (see step names below)
 *   DAINTREE_SHOT_OUT      output directory override
 *
 * Switching themes in place crashes the project view under this harness (the
 * same failure `worktree-dialog-review` documents), so a sweep boots per theme:
 *
 *   for t in daintree namib bondi; do
 *     DAINTREE_SHOT_COMPARE=1 DAINTREE_SHOT_THEME=$t DAINTREE_SHOT_TAG=$t \
 *     npx playwright test --project=screenshots cross-worktree-diff-review
 *   done
 *
 * Output: artifacts/compare-dialog-shots/<NN-slug>[-tag].png (gitignored).
 */

import { test, expect, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_COMPARE;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR =
  process.env.DAINTREE_SHOT_OUT ?? path.resolve(process.cwd(), "artifacts", "compare-dialog-shots");

const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

const WT_FEATURE = "feature/checkout-redesign";
const WT_SAME = "chore/tidy-imports";
const WT_LONG = "feature/observability-pipeline-opentelemetry-span-exporter-backpressure";

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content);
}

/**
 * `main` plus three worktrees: one with a committed change set that exercises
 * every file-row variant, one sitting on main's exact commit (the "no
 * differences" state), and one with a hostile branch name for the selectors.
 */
function createFixtureRepo(): { dir: string; wtRoot: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-compare-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  write(dir, "README.md", "# Helios Storefront\n\nA storefront for the Helios catalogue.\n");
  write(
    dir,
    "src/checkout/index.ts",
    'export { submitOrder } from "./submit";\nexport const CHECKOUT_VERSION = 1;\n'
  );
  write(
    dir,
    "src/checkout/submit.ts",
    [
      'import { api } from "../api/client";',
      "",
      "export async function submitOrder(cartId: string): Promise<string> {",
      '  const res = await api.post("/orders", { cartId });',
      "  return res.id;",
      "}",
      "",
    ].join("\n")
  );
  write(dir, "src/cart/index.ts", 'export const CART_KEY = "helios.cart";\n');
  write(
    dir,
    "src/api/client.ts",
    [
      "export const api = {",
      "  async post(url: string, body: unknown): Promise<{ id: string }> {",
      "    const res = await fetch(url, { method: 'POST', body: JSON.stringify(body) });",
      "    return res.json();",
      "  },",
      "};",
      "",
    ].join("\n")
  );
  write(dir, "src/legacy/paypal-button.ts", "export const PAYPAL_ENABLED = true;\n");
  write(dir, "src/utils/money.ts", "export const format = (n: number) => `$${n}`;\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);

  for (const branch of [WT_FEATURE, WT_SAME, WT_LONG]) {
    git(`branch ${branch}`, dir);
    git(
      `worktree add ${JSON.stringify(path.join(wtRoot, branch.replace(/\//g, "-")))} ${branch}`,
      dir
    );
  }

  const feature = path.join(wtRoot, WT_FEATURE.replace(/\//g, "-"));
  write(
    feature,
    "README.md",
    [
      "# Helios Storefront",
      "",
      "A storefront for the Helios catalogue, now with a single-page checkout that keeps the cart, the shipping address and the payment step on one screen so nobody loses their place halfway through an order.",
      "",
      "## Checkout",
      "",
      "Orders are submitted through the retrying API client, which backs off on 429 and 503 responses.",
      "",
    ].join("\n")
  );
  write(
    feature,
    "src/checkout/index.ts",
    'export { submitOrder } from "./submit";\nexport { CheckoutSummary } from "./CheckoutSummary";\nexport const CHECKOUT_VERSION = 2;\n'
  );
  write(
    feature,
    "src/checkout/submit.ts",
    [
      'import { api } from "../api/client";',
      'import { withRetry } from "../api/retry";',
      "",
      "export async function submitOrder(cartId: string, idempotencyKey: string): Promise<string> {",
      '  const res = await withRetry(() => api.post("/orders", { cartId, idempotencyKey }), { attempts: 4, backoffMs: 250 });',
      "  return res.id;",
      "}",
      "",
    ].join("\n")
  );
  write(
    feature,
    "src/checkout/CheckoutSummary.tsx",
    [
      'import { format } from "../utils/currency";',
      "",
      "export function CheckoutSummary({ total }: { total: number }) {",
      '  return <p className="summary">Total {format(total)}</p>;',
      "}",
      "",
    ].join("\n")
  );
  write(
    feature,
    "src/cart/index.ts",
    'export const CART_KEY = "helios.cart.v2";\nexport const CART_TTL_DAYS = 30;\n'
  );
  write(
    feature,
    "src/api/retry.ts",
    [
      "export async function withRetry<T>(fn: () => Promise<T>, opts: { attempts: number; backoffMs: number }): Promise<T> {",
      "  let lastError: unknown;",
      "  for (let i = 0; i < opts.attempts; i++) {",
      "    try {",
      "      return await fn();",
      "    } catch (error) {",
      "      lastError = error;",
      "      await new Promise((r) => setTimeout(r, opts.backoffMs * 2 ** i));",
      "    }",
      "  }",
      "  throw lastError;",
      "}",
      "",
    ].join("\n")
  );
  rmSync(path.join(feature, "src/legacy/paypal-button.ts"));
  git("mv src/utils/money.ts src/utils/currency.ts", feature);
  write(
    feature,
    "packages/telemetry-exporter/src/internal/span-exporter-backpressure-strategy.ts",
    "export const STRATEGY = 'drop-oldest';\n"
  );
  git("add -A", feature);
  git('commit -m "single-page checkout"', feature);

  return {
    dir,
    wtRoot,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 500): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

const written: string[] = [];

function dialog(page: Page) {
  return page.getByRole("dialog", { name: "Compare worktrees" });
}

/** The role sits on the backdrop; the card is its first child. */
function panel(page: Page) {
  return dialog(page).locator(":scope > div").first();
}

async function snap(page: Page, slug: string, whole = false): Promise<void> {
  await settle(page);
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  if (whole) {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  } else {
    await panel(page).screenshot({ path: file, type: "png" });
  }
  written.push(path.basename(file));
}

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
let activePage: Page | undefined;
let expectedShots = 0;

async function step(name: string, shots: number, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  expectedShots += shots;
  try {
    await fn();
  } catch (error) {
    console.warn(`[compare-shots] step "${name}" FAILED:`, String(error).slice(0, 400));
  }
  if (activePage) await closeDialog(activePage);
}

async function openActionsMenu(page: Page): Promise<void> {
  const card = page.locator(SEL.worktree.mainCard).first();
  await card.scrollIntoViewIfNeeded().catch(() => {});
  await card.hover().catch(() => {});
  await card.locator(SEL.worktree.actionsMenu).first().click();
  await page.locator('[role="menu"]').first().waitFor({ state: "visible", timeout: 5000 });
  await settle(page, 300);
}

/** Opens from the main card, so the base side arrives preselected as `main`. */
async function openDialog(page: Page): Promise<void> {
  await openActionsMenu(page);
  // The item lives in the menu's "Review" submenu. SubTriggers open on hover,
  // but one that lands mid-enter-animation is dropped — click is the fallback.
  const review = page.getByRole("menuitem", { name: /^Review$/ }).first();
  await review.hover();
  await settle(page, 400);
  const item = page.getByRole("menuitem", { name: /compare with another worktree/i }).first();
  if (!(await item.isVisible().catch(() => false))) {
    await review.click();
    await settle(page, 400);
  }
  await item.click({ timeout: 10000 });
  await dialog(page).waitFor({ state: "visible", timeout: 8000 });
  await settle(page, 600);
}

async function closeDialog(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if (
      !(await dialog(page)
        .isVisible()
        .catch(() => false))
    )
      return;
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 250);
  }
}

/** Picks the compare side by the branch its option names. */
async function pickCompare(page: Page, branch: string): Promise<void> {
  const selects = dialog(page).locator("select");
  const target = selects.nth(1);
  const value = await target.evaluate((el, b) => {
    const opt = Array.from((el as HTMLSelectElement).options).find((o) =>
      o.textContent?.includes(b)
    );
    return opt?.value ?? "";
  }, branch);
  if (!value) throw new Error(`no compare option for ${branch}`);
  await target.selectOption(value);
  await settle(page, 1500);
}

async function openFile(page: Page, name: string): Promise<void> {
  await dialog(page)
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click();
  // The diff viewer tokenises off the main thread; wait for its rows.
  await dialog(page)
    .locator(".diff-scroll-root table, .diff-scroll-root [class*='diff']")
    .first()
    .waitFor({ state: "visible", timeout: 8000 })
    .catch(() => {});
  await settle(page, 1200);
}

test("cross-worktree compare dialog review — every state", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_COMPARE is required for the compare-dialog capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_COMPARE to run the compare-dialog capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-compareshot-"));
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Storefront");
    activePage = page;
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await page
      .locator(SEL.worktree.mainCard)
      .waitFor({ state: "visible", timeout: T_LONG })
      .catch(() => {});
    await settle(page, 3000);
    await dismissBlockingPalette(page);

    // 1. Just opened: base preselected, compare empty — the first thing
    //    anyone sees, and the state that has to say what to do next.
    await step("initial", 2, async () => {
      await openDialog(page);
      await snap(page, "10-initial");
      await snap(page, "11-initial-in-window", true);
    });

    // 2. Both sides picked, no file open — the list and its summary line.
    await step("list", 1, async () => {
      await openDialog(page);
      await pickCompare(page, WT_FEATURE);
      await snap(page, "20-list");
    });

    // 3. A code file open in the split diff, with the stepper.
    await step("code-diff", 2, async () => {
      await openDialog(page);
      await pickCompare(page, WT_FEATURE);
      await openFile(page, "submit\\.ts");
      await snap(page, "30-code-diff");
      await snap(page, "31-code-diff-in-window", true);
    });

    // 4. Prose file — wrap defaults on.
    await step("prose-diff", 1, async () => {
      await openDialog(page);
      await pickCompare(page, WT_FEATURE);
      await openFile(page, "README\\.md");
      await snap(page, "40-prose-diff");
    });

    // 5. Basename collision: two `index.ts` files, the second one open.
    await step("collision", 1, async () => {
      await openDialog(page);
      await pickCompare(page, WT_FEATURE);
      const rows = dialog(page).getByRole("button", { name: /index\.ts/ });
      await rows.nth(1).click();
      await settle(page, 1500);
      await snap(page, "50-basename-collision");
    });

    // 6. Same commit, different branch: the "no differences" state.
    await step("identical", 1, async () => {
      await openDialog(page);
      await pickCompare(page, WT_SAME);
      await snap(page, "60-identical");
    });

    // 7. Hostile branch name in the compare selector.
    await step("long-branch", 1, async () => {
      await openDialog(page);
      await pickCompare(page, WT_LONG.slice(0, 40));
      await snap(page, "70-long-branch");
    });

    // 8. Keyboard: Tab from open into the list and onto a file row.
    await step("focus", 1, async () => {
      await openDialog(page);
      await pickCompare(page, WT_FEATURE);
      await dialog(page)
        .getByRole("button", { name: /submit\.ts/ })
        .first()
        .focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await snap(page, "80-focus-row");
    });

    // 9. Forced colors — status letters and counts lean on colour.
    await step("forced-colors", 1, async () => {
      await page.emulateMedia({ forcedColors: "active" }).catch(() => {});
      await openDialog(page);
      await pickCompare(page, WT_FEATURE);
      await openFile(page, "submit\\.ts");
      await snap(page, "90-forced-colors");
      await page.emulateMedia({ forcedColors: "none" }).catch(() => {});
    });

    console.log(`[compare-shots] wrote ${written.length}/${expectedShots}: ${written.join(", ")}`);
    expect(written.length, "every requested state must produce a verified PNG").toBe(expectedShots);
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
