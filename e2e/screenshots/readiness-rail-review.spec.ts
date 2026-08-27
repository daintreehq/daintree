/**
 * ReadinessRail visual-review harness (#11983).
 *
 * The rail is the compact merge-readiness strip between the Review Hub header and its
 * review body. Its design question — is the *ready* state louder than it deserves, and
 * does the *attention* state stay legible instead of becoming a status wall — can only be
 * judged on rendered pixels, in situ, against the dense hub it sits inside.
 *
 * Every state is driven through the real data seam: `git:get-staging-status`, the same
 * IPC handler `ReviewHubContent` already invokes. The stub returns a fabricated
 * `StagingStatus`, `deriveReviewReadiness` runs for real on top of it, and the rail
 * renders whatever that derivation produces. Nothing about the component or the
 * derivation is mocked, so a shot is evidence about the shipping code path.
 *
 * The hub re-fetches on open, so each state closes and reopens the dialog rather than
 * trying to poke a live one.
 *
 *   DAINTREE_SHOT_READINESS=1 npx playwright test --project=screenshots readiness-rail-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_READINESS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME      optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG        optional suffix so rounds sit side by side
 *   DAINTREE_SHOT_ONLY       comma-separated state filter (see STATES below)
 *   DAINTREE_SHOT_DIR        output directory override
 *   DAINTREE_SHOT_SWEEP      only capture the states marked `sweep` (theme sweep)
 *
 * Switching themes in place crashes the project view under this harness (same constraint
 * as confirm-dialog-review), so a theme sweep boots once per theme:
 *
 *   for t in arashiyama atacama bali bondi daintree fiordland galapagos highlands \
 *            hokkaido movile namib redwoods serengeti svalbard table-mountain; do
 *     DAINTREE_SHOT_READINESS=1 DAINTREE_SHOT_SWEEP=1 DAINTREE_SHOT_THEME=$t \
 *     npx playwright test --project=screenshots readiness-rail-review
 *   done
 *
 * Output: artifacts/readiness-rail-shots/<slug>--<theme>[-tag].png (gitignored).
 */

import { test, expect, type Page, type ElectronApplication } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type {
  GitStatus,
  StagingFileEntry,
  StagingStatus,
  ConflictedFileEntry,
} from "../../shared/types/git";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";

const ENABLED = !!process.env.DAINTREE_SHOT_READINESS;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const THEME_SLUG = THEME || "default";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const SWEEP_ONLY = !!process.env.DAINTREE_SHOT_SWEEP;
const OUTPUT_DIR = process.env.DAINTREE_SHOT_DIR
  ? path.resolve(process.env.DAINTREE_SHOT_DIR)
  : path.resolve(process.cwd(), "artifacts", "readiness-rail-shots");

const STAGING_CHANNEL = "git:get-staging-status";
const RAIL = '[data-testid="review-readiness-rail"]';
const LEVEL = '[data-testid="review-readiness-level"]';
const OVERFLOW = '[data-testid="review-readiness-overflow"]';
const item = (id: string) => `[data-testid="readiness-item-${id}"]`;

const WIDE = { width: 1680, height: 1050 };
const NARROW = { width: 900, height: 900 };

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

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

/** A repo with real uncommitted work, so the hub has a body under the rail. */
function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-readiness-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(path.join(dir, "src", "index.ts"), "export const version = 1;\n");
  writeFileSync(path.join(dir, "src", "checkout.ts"), "export function checkout() {}\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);

  // Real dirt so the file sections below the rail are populated.
  writeFileSync(
    path.join(dir, "src", "index.ts"),
    "export const version = 2;\nexport const b = 1;\n"
  );
  writeFileSync(
    path.join(dir, "src", "checkout.ts"),
    "export function checkout() {\n  return 1;\n}\n"
  );
  writeFileSync(path.join(dir, "src", "cart.ts"), "export function cart() {}\n");
  git("add src/index.ts", dir);

  return {
    dir,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function file(p: string, status: GitStatus = "modified"): StagingFileEntry {
  return { path: p, status, insertions: 14, deletions: 3 };
}

function conflict(p: string): ConflictedFileEntry {
  return { path: p, xy: "UU", label: "both modified" };
}

function status(over: Partial<StagingStatus> = {}): StagingStatus {
  const branch = over.currentBranch === undefined ? "feature/checkout-retry" : over.currentBranch;
  return {
    staged: [],
    unstaged: [],
    conflicted: [],
    conflictedFiles: [],
    isDetachedHead: false,
    currentBranch: branch,
    hasRemote: true,
    pushDestination: branch ? { remote: "origin", branch } : null,
    pullSource: branch ? { remote: "origin", branch } : null,
    repoState: "CLEAN",
    rebaseStep: null,
    rebaseTotalSteps: null,
    rebaseSequence: null,
    ...over,
  };
}

const SRC = [file("src/checkout.ts"), file("src/cart.ts"), file("src/index.ts")];
const GENERATED = [
  file("package-lock.json"),
  file("dist/bundle.min.js"),
  file("src/api.generated.ts"),
];

interface RailState {
  slug: string;
  /** `"pending"` never resolves, which is how the hub's real "status unknown" looks. */
  status: StagingStatus | "pending";
  /** `null` asserts the rail is absent. */
  level: "ready" | "needs-review" | "blocked" | null;
  items?: string[];
  overflow?: boolean;
  /** Included in the per-theme sweep. */
  sweep?: boolean;
  /**
   * `"page"` shoots the whole window and skips the rail crop — the disclosure
   * popover is portalled outside the dialog, so a container-scoped shot would
   * frame it out entirely.
   */
  capture?: "hub" | "page";
  /** Runs after the state renders and before the shot. */
  arrange?: (page: Page, app: ElectronApplication) => Promise<void>;
  /** Runs after the shot, whether or not it succeeded. */
  restore?: (page: Page, app: ElectronApplication) => Promise<void>;
}

async function setWindowSize(
  app: ElectronApplication,
  size: { width: number; height: number }
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setSize(s.width, s.height);
  }, size);
}

const STATES: RailState[] = [
  {
    // Staging status has not resolved. The rail must render nothing at all rather
    // than a placeholder — this shot is the proof.
    slug: "01-unknown",
    status: "pending",
    level: null,
  },
  {
    // The state the issue is about: a clean worktree, nothing to do, and a full-width
    // green band saying so.
    slug: "02-ready-clean",
    status: status(),
    // Nothing to report: the strip must not render at all.
    level: null,
    sweep: true,
  },
  {
    slug: "03-ready-info",
    status: status({ staged: SRC }),
    level: "ready",
    items: ["pr-missing"],
    // The lone info IS the leading condition, so there is nothing to disclose.
  },
  {
    slug: "04-attention-single",
    status: status({ unstaged: SRC }),
    level: "needs-review",
    items: ["nothing-staged"],
    overflow: true,
  },
  {
    slug: "05-attention-multi",
    status: status({ unstaged: GENERATED }),
    level: "needs-review",
    items: ["generated-only"],
    overflow: true,
    sweep: true,
  },
  {
    slug: "06-blocked-conflicts",
    status: status({
      repoState: "DIRTY",
      staged: [file("src/index.ts")],
      unstaged: [file("src/cart.ts")],
      conflicted: ["src/checkout.ts", "src/api.ts", "src/router.ts"],
      conflictedFiles: [
        conflict("src/checkout.ts"),
        conflict("src/api.ts"),
        conflict("src/router.ts"),
      ],
    }),
    level: "blocked",
    items: ["conflicts"],
    overflow: true,
    sweep: true,
  },
  {
    // A blocker with no safe action — the rail has to read well without a CTA.
    slug: "07-blocked-rebase",
    status: status({
      repoState: "REBASING",
      rebaseStep: 2,
      rebaseTotalSteps: 5,
      staged: [file("src/index.ts")],
      conflicted: ["src/checkout.ts", "src/api.ts"],
      conflictedFiles: [conflict("src/checkout.ts"), conflict("src/api.ts")],
    }),
    level: "blocked",
    items: ["operation-in-progress"],
    overflow: true,
  },
  {
    slug: "08-blocked-detached",
    status: status({ currentBranch: null, isDetachedHead: true, staged: SRC.slice(0, 2) }),
    level: "blocked",
    items: ["detached-head"],
    overflow: true,
  },
  {
    // Four items: past MAX_VISIBLE_ITEMS, so the "+N more" affordance is on screen.
    slug: "09-overflow",
    status: status({ currentBranch: "main", unstaged: GENERATED }),
    level: "needs-review",
    items: ["generated-only"],
    overflow: true,
  },
  {
    // Four conditions, every one carrying a detail — the case that used to wrap the
    // strip onto a second line at full width.
    slug: "10-dense",
    status: status({ currentBranch: "main", hasRemote: false, unstaged: GENERATED }),
    level: "needs-review",
    items: ["generated-only"],
    overflow: true,
  },
  {
    // Keyboard affordance: the CTA's focus ring, which is the only way a keyboard
    // user can tell the rail is interactive at all.
    slug: "11-cta-focus",
    status: status({ unstaged: SRC }),
    level: "needs-review",
    items: ["nothing-staged"],
    overflow: true,
    arrange: async (page) => {
      // `:focus-visible` does not match a programmatic `.focus()` — the browser only
      // treats focus as keyboard-driven after a real key event. Land on the CTA, step
      // off it, then Tab forward until a real key event puts focus back on it.
      const cta = page.locator('[data-testid^="readiness-cta-"]').first();
      await cta.focus();
      await page.keyboard.press("Shift+Tab");
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Tab");
        const state = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return {
            testid: el?.getAttribute("data-testid") ?? el?.tagName ?? "none",
            visible: !!el?.matches(":focus-visible"),
          };
        });
        if (state.testid.startsWith("readiness-cta-")) {
          const computed = await page.evaluate(() => {
            const el = document.activeElement as HTMLElement;
            const cs = getComputedStyle(el);
            return [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.outlineOffset].join("|");
          });
          console.log(
            `[readiness-shots] focus landed on ${state.testid}, :focus-visible=${state.visible}, outline=${computed}`
          );
          if (!state.visible) throw new Error("CTA focused but :focus-visible did not match");
          // A ring that resolves to `outline-style: none` is invisible however correct
          // its colour and width look — that is exactly how Tailwind v4's
          // `outline-hidden` silently cancels `focus-visible:outline-2`. Refuse to
          // write a "focused" shot that shows no focus.
          if (computed.startsWith("none")) {
            throw new Error(`focus ring resolves to no outline: ${computed}`);
          }
          return;
        }
      }
      throw new Error("could not Tab onto the rail CTA");
    },
  },
  {
    // The disclosure open: every remaining condition, its detail, and its action —
    // the surface that replaced a `title` attribute nobody could open.
    slug: "15-disclosure-open",
    status: status({ currentBranch: "main", hasRemote: false, unstaged: GENERATED }),
    level: "needs-review",
    items: ["generated-only"],
    overflow: true,
    capture: "page",
    arrange: async (page) => {
      await page.locator(OVERFLOW).click();
      // The hub itself is a `role="dialog"` containing the leading condition, so wait
      // on the trigger's own expanded state plus an item only the popover can hold.
      await page
        .locator(`${OVERFLOW}[aria-expanded="true"]`)
        .waitFor({ state: "visible", timeout: 5000 });
      await page.locator(item("no-remote")).waitFor({ state: "visible", timeout: 5000 });
    },
    restore: async (page) => {
      await page.keyboard.press("Escape").catch(() => {});
    },
  },
  {
    slug: "12-forced-colors",
    status: status({ currentBranch: "main", hasRemote: false, unstaged: GENERATED }),
    level: "needs-review",
    items: ["generated-only"],
    overflow: true,
    arrange: async (page) => {
      await page.emulateMedia({ forcedColors: "active" });
    },
    restore: async (page) => {
      await page.emulateMedia({ forcedColors: "none" });
    },
  },
  {
    slug: "13-contrast-more",
    status: status({ currentBranch: "main", hasRemote: false, unstaged: GENERATED }),
    level: "needs-review",
    items: ["generated-only"],
    overflow: true,
    arrange: async (page) => {
      await page.emulateMedia({ contrast: "more" });
    },
    restore: async (page) => {
      await page.emulateMedia({ contrast: "no-preference" });
    },
  },
  {
    // Narrow pane: does the rail wrap into a multi-line wall and shove the review
    // body down the screen?
    slug: "14-narrow",
    status: status({ currentBranch: "main", hasRemote: false, unstaged: GENERATED }),
    level: "needs-review",
    items: ["generated-only"],
    overflow: true,
    arrange: async (_page, app) => setWindowSize(app, NARROW),
    restore: async (_page, app) => setWindowSize(app, WIDE),
  },
];

async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/**
 * Replace the staging-status handler. `"pending"` installs one that never settles,
 * which is the only honest way to render the hub's pre-resolution state.
 */
async function stubStagingStatus(
  app: ElectronApplication,
  next: StagingStatus | "pending"
): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, { channel, response }) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async () => {
        if (response === "pending") return new Promise(() => {});
        return response;
      });
    },
    { channel: STAGING_CHANNEL, response: next }
  );
}

/* Generous, because this harness is routinely run on a machine with a dozen other
   worktrees building at once; at load average 20+ the worktree card takes seconds to
   paint and a tight timeout reports a layout regression that isn't one. */
async function openHub(page: Page): Promise<void> {
  await dismissBlockingPalette(page);
  await page.locator(SEL.worktree.mainCard).first().waitFor({ state: "visible", timeout: 30_000 });
  await page.locator(SEL.worktree.mainCard).first().hover();
  await settle(page, 250);
  const btn = page.locator(SEL.worktree.reviewHubButton).first();
  await btn.waitFor({ state: "visible", timeout: 30_000 });
  await btn.click();
  await page.locator(SEL.reviewHub.container).waitFor({ state: "visible", timeout: 30_000 });
}

async function closeHub(page: Page): Promise<void> {
  await page
    .locator(SEL.reviewHub.close)
    .click()
    .catch(() => {});
  await page
    .locator(SEL.reviewHub.container)
    .waitFor({ state: "hidden", timeout: 8000 })
    .catch(() => {});
  await settle(page, 200);
}

/**
 * Verify AFTER the settle and BEFORE the shot. A state that did not render must throw
 * rather than write a plausible-looking PNG of the wrong screen — a wrong artifact sends
 * the whole review off reasoning about a surface that does not exist.
 */
async function verify(page: Page, state: RailState): Promise<void> {
  await expect(
    page.locator(SEL.reviewHub.container),
    `${state.slug}: review hub did not open`
  ).toBeVisible({ timeout: 10_000 });

  if (state.level === null) {
    await expect(
      page.locator(RAIL),
      `${state.slug}: expected no rail, but one rendered`
    ).toHaveCount(0, { timeout: 8000 });
    return;
  }

  await expect(page.locator(LEVEL), `${state.slug}: readiness level chip missing`).toHaveAttribute(
    "data-level",
    state.level,
    { timeout: 10_000 }
  );

  for (const id of state.items ?? []) {
    await expect(
      page.locator(item(id)),
      `${state.slug}: expected readiness item "${id}" to render`
    ).toBeVisible({ timeout: 8000 });
  }

  if (state.overflow) {
    await expect(
      page.locator(OVERFLOW),
      `${state.slug}: expected the "+N more" overflow affordance`
    ).toBeVisible({ timeout: 8000 });
  }
}

async function snap(page: Page, slug: string, locator: string | null): Promise<void> {
  const target = locator === null ? page : page.locator(locator).first();
  await target.screenshot({
    path: path.join(OUTPUT_DIR, `${slug}--${THEME_SLUG}${TAG}.png`),
    type: "png",
    animations: "disabled",
    caret: "hide",
  });
}

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

/* A failed state must not abort the run — the rest are still worth having, and a
   fifteen-theme sweep shouldn't lose fourteen themes to one bad selector. But the run
   must still FAIL: a silent exit 0 over an empty output directory reads as success. */
const failures: string[] = [];
let captured = 0;

test("readiness rail review — ready, attention and blocked states", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_READINESS is required for the readiness-rail capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_READINESS to run the readiness-rail capture");

  failures.length = 0;
  captured = 0;

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-readinessshot-"));
  let ctx: AppContext | undefined;

  const planned = STATES.filter(
    (s) => (ONLY.length === 0 || ONLY.includes(s.slug)) && (!SWEEP_ONLY || s.sweep)
  );

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: WIDE,
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS });
    await settle(page, 600);

    for (const state of planned) {
      const app = ctx.app;
      try {
        await closeHub(page);
        await stubStagingStatus(app, state.status);
        await openHub(page);
        await settle(page, 700);
        if (state.arrange) await state.arrange(page, app);
        await settle(page, 450);

        await verify(page, state);

        if (state.capture === "page") {
          await snap(page, `${state.slug}--page`, null);
          captured++;
        } else {
          await snap(page, `${state.slug}--hub`, SEL.reviewHub.container);
          captured++;
          if (state.level !== null) {
            await snap(page, `${state.slug}--rail`, RAIL);
            captured++;
          }
        }
      } catch (error) {
        const detail = String(error).slice(0, 400);
        console.warn(`[readiness-shots] state "${state.slug}" failed:`, detail);
        failures.push(`${state.slug}: ${detail}`);
      } finally {
        if (state.restore) {
          await state.restore(page, app).catch((error) => {
            failures.push(`${state.slug} (restore): ${String(error).slice(0, 200)}`);
          });
        }
      }
    }
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  // The exit code is only meaningful if it accounts for what actually landed on disk.
  const expected = planned.reduce(
    (n, s) => n + (s.capture === "page" || s.level === null ? 1 : 2),
    0
  );
  console.log(`[readiness-shots] ${captured}/${expected} PNGs → ${OUTPUT_DIR}`);
  if (failures.length > 0) {
    throw new Error(`readiness-rail capture failed:\n  ${failures.join("\n  ")}`);
  }
  expect(captured, `expected ${expected} PNGs, wrote ${captured}`).toBe(expected);
});
