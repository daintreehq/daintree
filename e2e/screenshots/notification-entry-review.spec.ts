/**
 * NotificationCenterEntry visual-review harness (#11988).
 *
 * One inbox row carries severity, unread state, title, message, thread count,
 * contextual actions, timestamp, snooze state, an overflow menu and dismissal —
 * inside a 360px popover. The trailing rail is the contested space: snooze
 * state, time and the two management controls now hold one grid cell at every
 * state, quiet at rest and stronger under the pointer — the build this harness
 * was written against instead faded an absolutely positioned action layer in
 * *over* the metadata. Whether the rail reads as a stable row or a temporary
 * patch is a pixel question, so it gets captured.
 *
 * Seeds the full history through `seedHistory` on the E2E notification backdoor
 * (`src/lib/e2eNotificationBackdoor.ts`) — the store's own setState, with real
 * timestamps, real action manifests, and real context — then drives every state
 * axis the issue names.
 *
 * Steps (each also the DAINTREE_SHOT_ONLY filter name):
 *
 *   rest        the seeded list at rest, list + popover. Doubles as the
 *               coarse-pointer state — see the note at the `contrast` step.
 *   hover       pointer hover on a metadata-rich row
 *   focus       keyboard focus (roving tabindex) on the same row
 *   menu        the row overflow menu open
 *   contrast    `prefers-contrast: more`
 *   forced      `forced-colors: active`
 *   dense       long titles / long relative times / big thread counts
 *   archived    the Archived tab (dismiss unavailable)
 *   snoozed     the Snoozed tab
 *
 * Opt-in only, like confirm-dialog-review: skips itself unless
 * DAINTREE_SHOT_NOTIF is set, so the marketing screenshots workflow never runs it.
 *
 *   DAINTREE_SHOT_NOTIF=1 npx playwright test --project=screenshots notification-entry-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_NOTIF   required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME   optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG     optional suffix so rounds sit side by side
 *   DAINTREE_SHOT_ONLY    comma-separated step filter (see step names above)
 *
 * Output: artifacts/notification-entry-shots/<NN-slug>[-tag].png (gitignored).
 */

import { test, type CDPSession, type Locator, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { seedNotificationHistory, type SeedHistoryEntry } from "../helpers/notifications";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_NOTIF;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = path.resolve(process.cwd(), "artifacts", "notification-entry-shots");

/** The popover card, so a shot is the inbox rather than the whole app window. */
const POPOVER = SEL.notifications.center;

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

function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-notif-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  git("branch develop", dir);
  git("checkout develop", dir);

  return {
    dir,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The review fixture. Every axis the issue's capture matrix names is present in
 * one list so a single shot is comparable across rounds: read/unread, titled/
 * untitled, threaded/solo, actions/no actions, snoozed/active, dismissible/not,
 * and the four relative-time shapes (`just now`, `Nm ago`, `Yesterday HH:MM`,
 * `Mar 4`, `Mar 4 2024`).
 *
 * `project.silenceNotificationKind` and `project.muteNotifications` are what the
 * overflow menu keys off, so `context.eventKind` / `context.projectId` decide
 * whether a row even has a menu — rows deliberately vary on both.
 */
function buildFixture(now: number): SeedHistoryEntry[] {
  const PROJECT = "helios-dashboard";
  return [
    // Unread error, threaded (3), contextual actions, full menu, dismissible.
    ...[0, 1, 2].map((i) => ({
      id: `err-${i}`,
      type: "error" as const,
      title: "Push rejected",
      message: "The remote has commits your branch doesn't. Pull with rebase, then push again.",
      timestamp: now - 45_000 - i * MINUTE,
      correlationId: "thread-push-rejected",
      seenAsToast: false,
      context: { projectId: PROJECT, eventKind: "git", panelId: "panel-git-1" },
      actions: [
        { label: "Pull and rebase", actionId: "git.push" },
        { label: "Open review", actionId: "app.settings.openTab", variant: "secondary" as const },
      ],
    })),
    // Unread warning, no title, short relative time, one action.
    {
      id: "warn-untitled",
      type: "warning",
      message: "Claude has been waiting for input for 4 minutes in feature/refine-inbox.",
      timestamp: now - 4 * MINUTE,
      correlationId: "thread-waiting-claude",
      seenAsToast: false,
      context: { projectId: PROJECT, eventKind: "waiting", panelId: "panel-term-2" },
      actions: [{ label: "Go to terminal", actionId: "panel.focus" }],
    },
    // Read success, titled, no actions, hours-old.
    {
      id: "ok-worktree",
      type: "success",
      title: "Worktree created",
      message: "feature/issue-11988-refine-notificationcenterentry is ready.",
      timestamp: now - 3 * HOUR,
      correlationId: "thread-worktree-created",
      seenAsToast: true,
      context: { projectId: PROJECT, eventKind: "git" },
    },
    // Read info, yesterday, snoozed thread (see SNOOZED_ID below).
    {
      id: "info-snoozed",
      type: "info",
      title: "Update available",
      message: "Daintree 1.4.2 is ready to install. It'll apply on the next restart.",
      timestamp: now - 26 * HOUR,
      correlationId: "thread-update-available",
      seenAsToast: true,
      context: { projectId: PROJECT, eventKind: "settings" },
      actions: [{ label: "Restart and install", actionId: "app.settings.openTab" }],
    },
    // Read info, no correlationId at all → no snooze, no thread, minimal menu.
    {
      id: "info-bare",
      type: "info",
      title: "Theme changed",
      message: "Switched to Fiordland.",
      timestamp: now - 5 * DAY,
      seenAsToast: true,
    },
    // The lone-menu-item case. An eventKind with no correlationId and no
    // projectId leaves exactly one item in the overflow menu — every
    // icon-bearing one is filtered out — which is what the conditional icon
    // gutter has to notice. It is also the shape that shipped indented against
    // nothing, so it gets a capture of its own in the `menu` step.
    {
      id: "warn-connectivity-bare",
      type: "warning" as const,
      title: "GitHub token expired",
      message: "GitHub token expired — reconnect to restore GitHub features.",
      // Older than `info-bare` above it: `seedHistory` preserves input order and
      // the chronological list does not re-sort, so a newer entry here would
      // render an impossible 5-day -> 3-day sequence in every other capture.
      timestamp: now - 6 * DAY,
      seenAsToast: true,
      context: { eventKind: "connectivity" as const },
    },
    // The density case: long title, long message, prior-year timestamp, a big
    // thread count, and three actions all at once.
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => ({
      id: `dense-${i}`,
      type: "warning" as const,
      title: "Watchdog restarted the terminal host after repeated unresponsive checks",
      message:
        "The pty host stopped answering health checks three times in a row and was restarted. Open panels were reattached; scrollback older than the restart is gone.",
      timestamp: now - 400 * DAY - i * MINUTE,
      correlationId: "thread-watchdog",
      seenAsToast: true,
      context: { projectId: PROJECT, eventKind: "recovery", panelId: "panel-term-9" },
      actions: [
        { label: "Show host logs", actionId: "app.settings.openTab" },
        { label: "Restart terminal", actionId: "terminal.restart", variant: "secondary" as const },
        { label: "Report", actionId: "system.openExternal", variant: "secondary" as const },
      ],
    })),
    // Archived — the Archived tab, where dismissal is unavailable.
    {
      id: "archived-1",
      type: "success",
      title: "Merged pull request #11967",
      message: "feature/issue-11965-move-remaining-stacked-label merged into develop.",
      timestamp: now - 2 * DAY,
      archivedAt: now - DAY,
      seenAsToast: true,
      correlationId: "thread-merged-pr",
      context: { projectId: PROJECT, eventKind: "git" },
    },
  ];
}

const SNOOZED_THREAD = "thread-update-available";

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function snap(page: Page, slug: string, locator?: string): Promise<void> {
  await settle(page);
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  if (locator) {
    await page.locator(locator).last().screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }
}

/**
 * Assert the seeded content is actually painted before writing a PNG. Without
 * this the harness happily captures an empty inbox — the exact silent-wrong-
 * artifact failure that sends a whole review off reasoning about a screen that
 * doesn't exist.
 */
async function assertSeeded(page: Page, minRows: number): Promise<void> {
  const rows = page.locator(SEL.notifications.centerList).locator(SEL.notifications.centerRow);
  const count = await rows.count();
  if (count < minRows) {
    throw new Error(`expected at least ${minRows} inbox rows on screen, saw ${count}`);
  }
}

export const ALL_THEMES = [
  "arashiyama",
  "atacama",
  "bali",
  "bondi",
  "daintree",
  "fiordland",
  "galapagos",
  "highlands",
  "hokkaido",
  "movile",
  "namib",
  "redwoods",
  "serengeti",
  "svalbard",
  "table-mountain",
];

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

// A failed step must not abort the run — but the run must still FAIL, or an
// exit 0 over a half-empty output directory reads as success.
const failures: string[] = [];
async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).slice(0, 300);
    console.warn(`[notif-shots] step "${name}" failed:`, detail);
    failures.push(`${name}: ${detail}`);
  } finally {
    await resetMedia(page).catch(() => {});
    await reopenCenter(page).catch((error) => {
      failures.push(`${name} (reset): ${String(error).slice(0, 200)}`);
    });
  }
}

/**
 * Playwright's `emulateMedia` covers forced-colors and reduced-motion but not
 * `pointer` or `prefers-contrast`, so those go through CDP directly.
 *
 * The session is created once and held: `Emulation.setEmulatedMedia` overrides
 * are scoped to their CDP session, so detaching right after the send silently
 * reverts them — which produced three capture files byte-identical to the rest
 * state on the first run.
 */
let mediaSession: CDPSession | null = null;

async function setMediaFeatures(
  page: Page,
  features: { name: string; value: string }[]
): Promise<void> {
  mediaSession ??= await page.context().newCDPSession(page);
  await mediaSession.send("Emulation.setEmulatedMedia", { features });
  // Prove the override took. Without this a shot that is byte-identical to the
  // rest state is ambiguous — "this media query changes nothing here" and
  // "the emulation silently no-opped" look exactly the same on disk.
  for (const f of features) {
    const query = `(${f.name}: ${f.value})`;
    const matches = await page.evaluate((q) => window.matchMedia(q).matches, query);
    if (!matches) throw new Error(`media emulation did not apply: ${query}`);
  }
}

async function resetMedia(page: Page): Promise<void> {
  if (mediaSession) {
    await mediaSession.send("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
  }
  await page.emulateMedia({ forcedColors: null }).catch(() => {});
}

async function closeCenter(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if (
      !(await page
        .locator(SEL.notifications.centerList)
        .isVisible()
        .catch(() => false))
    )
      return;
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 200);
  }
}

/** Close and reopen the popover so each step starts from a known rest state. */
async function reopenCenter(page: Page): Promise<void> {
  await closeCenter(page);
  await dismissBlockingPalette(page);
  await page.locator(SEL.notifications.bellButton).click();
  await page
    .locator(SEL.notifications.centerList)
    .waitFor({ state: "visible", timeout: 8000 })
    .catch(() => {});
  await settle(page, 500);
}

/**
 * Put keyboard focus on a row the way the inbox's own roving tabindex does.
 *
 * A bare scripted `.focus()` is not enough — the reveal is `:focus-visible`
 * gated, and Chromium only sets that for keyboard-initiated focus. Tab does not
 * reach the rows either: the popover is portalled to the end of `document.body`
 * while the bell that opened it sits in the toolbar, so Tab walks the whole app
 * first. So: seed focus on row 0 programmatically, then press a real ArrowDown,
 * which lands in the list's own keydown handler and re-focuses from inside a
 * keyboard event — which is exactly the condition `:focus-visible` wants.
 */
async function focusFirstRowByKeyboard(page: Page): Promise<void> {
  await page
    .locator(SEL.notifications.centerList)
    .locator(SEL.notifications.centerRow)
    .first()
    .evaluate((el) => (el as HTMLElement).focus());
  await settle(page, 150);
}

/** The reveal is `:focus-visible`-gated — assert it actually matched. */
async function assertRowFocusVisible(page: Page): Promise<void> {
  const ok = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el.getAttribute("role") !== "listitem") return false;
    return el.matches(":focus-visible");
  });
  if (!ok) throw new Error("focused row did not match :focus-visible");
}

/** Throws unless the locator's box sits inside the popover's visible box. */
async function assertInsidePopover(page: Page, target: Locator): Promise<void> {
  const popover = await page.locator(POPOVER).last().boundingBox();
  const box = await target.boundingBox();
  if (!popover || !box) throw new Error("could not measure popover or target row");
  if (box.y < popover.y || box.y + box.height > popover.y + popover.height) {
    throw new Error(
      `target row is outside the popover viewport (row y=${Math.round(box.y)}h=${Math.round(
        box.height
      )}, popover y=${Math.round(popover.y)}h=${Math.round(popover.height)})`
    );
  }
}

/** Selects a filter tab by its visible label ("All" / "Archived" / "Snoozed"). */
async function selectFilter(page: Page, label: string): Promise<void> {
  await page.locator(SEL.notifications.centerFilter(label)).first().click();
  await settle(page, 400);
}

test("notification entry review — trailing rail, actions, and time", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_NOTIF is required for the inbox row capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_NOTIF to run the inbox row capture");

  failures.length = 0;
  mediaSession = null;

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-notifshot-"));
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await page
      .locator(SEL.worktree.mainCard)
      .waitFor({ state: "visible", timeout: T_LONG })
      .catch(() => {});
    await settle(page, 1500);
    await dismissBlockingPalette(page);

    const now = Date.now();
    await seedNotificationHistory(page, buildFixture(now), {
      [SNOOZED_THREAD]: now + 8 * HOUR,
    });
    await reopenCenter(page);
    await assertSeeded(page, 4);

    // 1. Rest — what the row looks like when nobody is touching it. The rail no
    //    longer hides the timestamp under hover, so this is the baseline the
    //    hover and focus captures are compared against rather than the only
    //    state that carries time.
    await step(page, "rest", async () => {
      await assertSeeded(page, 4);
      await snap(page, "10-rest-popover", POPOVER);
      await snap(page, "11-rest-window");
    });

    // 2. Hover — the action layer fades in over the timestamp. The whole issue.
    await step(page, "hover", async () => {
      const row = page.locator(SEL.notifications.centerList).locator(SEL.notifications.centerRow);
      await row.first().hover();
      await settle(page, 300);
      await snap(page, "20-hover-popover", POPOVER);
      await snap(page, "21-hover-row", `${SEL.notifications.centerRow} >> nth=0`);
    });

    // 3. Keyboard focus — same reveal, reached without a pointer.
    await step(page, "focus", async () => {
      await focusFirstRowByKeyboard(page);
      await page.keyboard.press("ArrowDown");
      await settle(page, 300);
      await assertRowFocusVisible(page);
      await snap(page, "30-focus-popover", POPOVER);
    });

    // 4. Open overflow menu — the row's management actions, and the state that
    //    pins the reveal open.
    await step(page, "menu", async () => {
      const row = page.locator(SEL.notifications.centerList).locator(SEL.notifications.centerRow);
      await row.first().hover();
      await settle(page, 250);
      await page.locator('button[aria-label="Notification options"]').first().click();
      await settle(page, 500);
      await snap(page, "40-menu-open-window");

      // The same menu reduced to its single text-only item. The gutter the
      // shot above allocates has to be gone here, not left as dead indent.
      // Re-seeded on its own for the same reason the dense step is: the row
      // sits far enough down the full fixture that it is never mounted, and
      // this harness has already established that scrolling the inbox to a
      // given row does not work. Restored before the next step.
      await page.keyboard.press("Escape");
      await settle(page, 250);
      try {
        await seedNotificationHistory(
          page,
          buildFixture(now).filter((e) => e.id === "warn-connectivity-bare")
        );
        await reopenCenter(page);
        const bareRow = page
          .locator(SEL.notifications.centerList)
          .locator(SEL.notifications.centerRow)
          .first();
        await bareRow.hover();
        await settle(page, 250);
        await bareRow.locator('button[aria-label="Notification options"]').click();
        await settle(page, 500);
        // The capture is only evidence if the menu really did reduce to one
        // item — otherwise a fixture drift that restores Snooze would leave a
        // correctly-guttered menu in the file under a name claiming otherwise.
        const itemCount = await page.locator('[role="menu"] [role="menuitem"]').count();
        if (itemCount !== 1) {
          throw new Error(`expected a single-item overflow menu, found ${itemCount}`);
        }
        await snap(page, "41-menu-lone-item-window");
      } finally {
        // In a finally, and carrying the snooze map the opening seed set: this
        // step is the only one that narrows the fixture without restoring it
        // through `dense`, and `contrast`, `forced` and `snoozed` all read the
        // full list. Dropping the map silently un-snoozes "Update available".
        await page.keyboard.press("Escape");
        await settle(page, 250);
        await seedNotificationHistory(page, buildFixture(now), {
          [SNOOZED_THREAD]: now + 8 * HOUR,
        });
        await reopenCenter(page);
      }
    });

    // 5. Coarse pointer has no capture of its own, deliberately. Chromium's
    //    `Emulation.setEmulatedMedia` has no `pointer` feature (only
    //    prefers-*/forced-colors/color-gamut), and a survey of the repo found
    //    zero `(pointer: coarse)` / `(hover: hover)` rules anywhere — so a touch
    //    session renders exactly `10-rest-popover`, byte for byte. That shot IS
    //    the coarse-pointer state: whatever is missing from it is missing for a
    //    touch user permanently. Writing a separate identical file would only
    //    dress that fact up as evidence it isn't.

    // 6. prefers-contrast: more (macOS "Increase contrast").
    await step(page, "contrast", async () => {
      await setMediaFeatures(page, [{ name: "prefers-contrast", value: "more" }]);
      await settle(page, 400);
      await snap(page, "60-high-contrast-popover", POPOVER);
    });

    // 7. forced-colors: active (Windows high-contrast). The overlay's own
    //    background is the thing most likely to collapse here.
    await step(page, "forced", async () => {
      await page.emulateMedia({ forcedColors: "active" });
      await settle(page, 500);
      if (!(await page.evaluate(() => matchMedia("(forced-colors: active)").matches))) {
        throw new Error("forced-colors emulation did not apply");
      }
      await snap(page, "70-forced-colors-popover", POPOVER);
      const row = page.locator(SEL.notifications.centerList).locator(SEL.notifications.centerRow);
      await row.first().hover();
      await settle(page, 300);
      await snap(page, "71-forced-colors-hover", POPOVER);
    });

    // 8. Density — the longest title, the biggest thread count, a prior-year
    //    timestamp and three action buttons in a 360px popover.
    await step(page, "dense", async () => {
      // Re-seed rather than scroll. The dense row sits ~20 rows down the full
      // fixture and nothing moved the inbox's scrollport to it — `scrollTop`,
      // `scrollIntoView` and 40 `mouse.wheel` ticks all left the row's box at
      // the same y. Seeding the dense entries on their own puts the case at the
      // top of the list: deterministic, and it isolates density from whatever
      // happens to be above it. The full fixture is restored before the next
      // step so Archived and Snoozed still have their rows.
      await seedNotificationHistory(
        page,
        buildFixture(now).filter((e) => e.id.startsWith("dense"))
      );
      await reopenCenter(page);
      const denseRow = page
        .locator(SEL.notifications.centerList)
        .locator(SEL.notifications.centerRow)
        .filter({ hasText: "Watchdog restarted" })
        .first();
      await assertInsidePopover(page, denseRow);
      await snap(page, "80-dense-popover", POPOVER);
      await denseRow.hover();
      await settle(page, 300);
      await snap(page, "81-dense-hover-popover", POPOVER);
      await seedNotificationHistory(page, buildFixture(now), {
        [SNOOZED_THREAD]: now + 8 * HOUR,
      });
      await reopenCenter(page);
    });

    // 9. Archived tab — dismissal unavailable, so the rail loses a control.
    await step(page, "archived", async () => {
      await selectFilter(page, "Archived");
      await snap(page, "90-archived-popover", POPOVER);
      await page
        .locator(SEL.notifications.centerList)
        .locator(SEL.notifications.centerRow)
        .first()
        .hover();
      await settle(page, 300);
      await snap(page, "91-archived-hover-popover", POPOVER);
    });

    // 10. Snoozed tab — the snooze clock and the timestamp share the rail.
    await step(page, "snoozed", async () => {
      await selectFilter(page, "Snoozed");
      await snap(page, "95-snoozed-popover", POPOVER);
      await page
        .locator(SEL.notifications.centerList)
        .locator(SEL.notifications.centerRow)
        .first()
        .hover();
      await settle(page, 300);
      await snap(page, "96-snoozed-hover-popover", POPOVER);
    });
  } finally {
    if (ctx?.app) await closeApp(ctx.app).catch(() => {});
    try {
      repo.cleanup();
    } catch {
      /* best effort */
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  const written = existsSync(OUTPUT_DIR)
    ? readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(`${TAG}.png`)).length
    : 0;
  console.warn(`[notif-shots] wrote ${written} png(s) to ${OUTPUT_DIR}`);

  if (failures.length > 0) {
    throw new Error(`[notif-shots] ${failures.length} step(s) failed:\n${failures.join("\n")}`);
  }
});
