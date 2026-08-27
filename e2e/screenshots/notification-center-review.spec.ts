/**
 * NotificationCenter popover visual-review harness (#12061).
 *
 * The sibling `notification-entry-review` spec owns one ROW. This one owns the
 * container around it: the popover's own box, the header, the filter chips, the
 * mute pill, the section labels, and — the reason the issue exists — the
 * scrollport. A row that renders perfectly is still unreachable if the list it
 * sits in clips it, so the states here are chosen to put the bottom edge of the
 * list under the lens rather than the middle of it.
 *
 * Seeds through `seedHistory` on the E2E notification backdoor
 * (`src/lib/e2eNotificationBackdoor.ts`) — the store's own setState, with real
 * timestamps and real action manifests — with a list deliberately long enough
 * and tall enough to overflow the popover many times over. A short fixture
 * cannot reproduce a scrolling defect.
 *
 * Beyond the PNGs it writes `geometry.json`: the scrollport's real
 * scrollHeight/clientHeight, the gap between the last row's bottom and the
 * scrollport's, and the left inset of every band of chrome down the panel.
 * "Padding is inconsistent" and "the last row is clipped" are measurable
 * claims, and a number settles them faster than an opinion about a picture.
 *
 * Steps (each also the DAINTREE_SHOT_ONLY filter name):
 *
 *   rest       the populated list at rest, popover + whole window
 *   scroll     scrolled to the very bottom, and the assertion that the
 *              scrollport is bounded by the panel rather than by its content
 *   actions    an action-carrying row parked at the bottom fold
 *   muted      the quiet-state strip, driven through the real Pause menu
 *   grouped    group-by-context on, so context section headers are present
 *   filters    Unread and Archived tabs
 *   empty      nothing to show, captured both while muted and after resuming
 *   viewport   the same popover on a laptop window and on a large one
 *   contrast   `prefers-contrast: more`
 *   forced     `forced-colors: active`
 *   themes     a spot check across three palettes
 *
 * Opt-in only, like notification-entry-review: skips itself unless
 * DAINTREE_SHOT_NOTIFCENTER is set, so the marketing screenshots workflow
 * never runs it.
 *
 *   DAINTREE_SHOT_NOTIFCENTER=1 npx playwright test --project=screenshots notification-center-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_NOTIFCENTER  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME        optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG          optional suffix so rounds sit side by side
 *   DAINTREE_SHOT_ONLY         comma-separated step filter (see step names above)
 *
 * Output: artifacts/notification-center-shots/<NN-slug>[-tag].png (gitignored).
 */

import { test, type CDPSession, type Page } from "@playwright/test";
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

const ENABLED = !!process.env.DAINTREE_SHOT_NOTIFCENTER;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = path.resolve(process.cwd(), "artifacts", "notification-center-shots");

/** The popover card, so a shot is the panel rather than the whole app window. */
const POPOVER = SEL.notifications.center;
const MUTED_PILL = '[data-testid="notification-muted-pill"]';

const POLISH_CSS = `
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
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-notifcenter-shots-"));
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
const PROJECT = "helios-dashboard";

/**
 * A list long enough for the scrollport to be the subject.
 *
 * The row heights deliberately vary by a factor of three or so — one-line
 * messages next to three-line ones next to rows carrying two action buttons —
 * because a uniform-height list is exactly the case where a wrong
 * `contain-intrinsic-size` guess looks fine. `Close them` / `Mute project` are
 * the real manifest from `useIdleTerminalNotifications`, which the issue names
 * as the worst case.
 */
function buildFixture(now: number): SeedHistoryEntry[] {
  const entries: SeedHistoryEntry[] = [
    // Severe + unread + threaded: this is what gets pinned into "Needs attention".
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
    {
      id: "idle-terminals",
      type: "warning",
      title: "4 terminals idle for 30 minutes",
      message:
        "Four background terminals in Helios Dashboard have been idle past your threshold. They're still holding worktrees open.",
      timestamp: now - 4 * MINUTE,
      correlationId: "thread-idle-terminals",
      seenAsToast: false,
      context: { projectId: PROJECT, eventKind: "system" },
      actions: [
        { label: "Close them", actionId: "terminal.kill" },
        { label: "Mute project", actionId: "app.settings.openTab", variant: "secondary" },
      ],
    },
  ];

  // The chronological body. Varied heights, varied ages, a couple of action
  // rows seeded near the end so the bottom of the list is the expensive case.
  const body: {
    title?: string;
    message: string;
    type: "info" | "success" | "warning" | "error";
    ageMs: number;
    kind: string;
    actions?: { label: string; actionId: string; variant?: "primary" | "secondary" }[];
  }[] = [
    {
      title: "Claude is waiting for input",
      message: "feature/refine-inbox has been waiting 4 minutes for an answer.",
      type: "warning",
      ageMs: 6 * MINUTE,
      kind: "waiting",
    },
    {
      message: "Formatted 23 files with Prettier.",
      type: "success",
      ageMs: 12 * MINUTE,
      kind: "system",
    },
    {
      title: "Worktree created",
      message:
        "feature/issue-12061-notification-center-dropdown is ready at ../daintree-worktrees.",
      type: "info",
      ageMs: 18 * MINUTE,
      kind: "git",
    },
    {
      title: "Build finished",
      message:
        "Renderer bundle built in 9.4s. Largest chunk is 412 kB, which is 38 kB over the budget you set for this project — the terminal panel's xterm addons account for most of the increase.",
      type: "success",
      ageMs: 34 * MINUTE,
      kind: "system",
    },
    {
      title: "2 terminals idle for 30 minutes",
      message: "Two background terminals in Helios Dashboard have been idle past your threshold.",
      type: "warning",
      ageMs: 52 * MINUTE,
      kind: "system",
      actions: [
        { label: "Close them", actionId: "terminal.kill" },
        { label: "Mute project", actionId: "app.settings.openTab", variant: "secondary" },
      ],
    },
    {
      message: "Codex finished reviewing 6 files.",
      type: "info",
      ageMs: 70 * MINUTE,
      kind: "completed",
    },
    {
      title: "Agent exited",
      message: "Gemini exited with code 1 in worktree feature/panel-restore.",
      type: "error",
      ageMs: 2 * HOUR,
      kind: "system",
    },
    {
      title: "Pull request opened",
      message: "#12044 Move the readiness rail behind a capability check.",
      type: "success",
      ageMs: 3 * HOUR,
      kind: "git",
    },
    {
      message: "MCP server accepted a connection from an external agent.",
      type: "info",
      ageMs: 5 * HOUR,
      kind: "system",
    },
    {
      title: "Disk space low",
      message:
        "The volume holding your worktrees has 4.2 GB free. Daintree keeps build output per worktree, so a fleet run can consume the remainder quickly.",
      type: "warning",
      ageMs: 9 * HOUR,
      kind: "system",
      actions: [{ label: "Open worktrees", actionId: "app.settings.openTab" }],
    },
    {
      title: "Plugin updated",
      message: "GitHub forge provider updated to 2.4.0.",
      type: "info",
      ageMs: 26 * HOUR,
      kind: "system",
    },
    {
      title: "Merged pull request #11967",
      message: "feature/issue-11965-move-remaining-stacked-label merged into develop.",
      type: "success",
      ageMs: 2 * DAY,
      kind: "git",
    },
    {
      message: "Watchdog restarted the pty host after an unresponsive check.",
      type: "warning",
      ageMs: 4 * DAY,
      kind: "system",
    },
  ];

  body.forEach((b, i) => {
    entries.push({
      id: `chrono-${i}`,
      type: b.type,
      title: b.title,
      message: b.message,
      timestamp: now - b.ageMs,
      correlationId: `thread-chrono-${i}`,
      // Read, so they stay out of "Needs attention" and land in the body where
      // the scrolling actually happens.
      seenAsToast: i > 1,
      context: { projectId: PROJECT, eventKind: b.kind },
      ...(b.actions ? { actions: b.actions } : {}),
    });
  });

  // One archived entry so the Archived tab has something to show.
  entries.push({
    id: "archived-1",
    type: "success",
    title: "Release 0.9.4 published",
    message: "macOS, Linux and Windows artifacts uploaded.",
    timestamp: now - 3 * DAY,
    archivedAt: now - 2 * DAY,
    seenAsToast: true,
    correlationId: "thread-released",
    context: { projectId: PROJECT, eventKind: "system" },
  });

  return entries;
}

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

// A failed step must not abort the run — but the run must still FAIL, or an
// exit 0 over a half-empty output directory reads as success.
const failures: string[] = [];
const geometry: Record<string, unknown> = {};

async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).slice(0, 300);
    console.warn(`[notifcenter-shots] step "${name}" failed:`, detail);
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
 * `prefers-contrast`, so that one goes through CDP directly. The session is
 * created once and held: `Emulation.setEmulatedMedia` overrides are scoped to
 * their CDP session, so detaching right after the send silently reverts them.
 */
let mediaSession: CDPSession | null = null;

async function setMediaFeatures(
  page: Page,
  features: { name: string; value: string }[]
): Promise<void> {
  mediaSession ??= await page.context().newCDPSession(page);
  await mediaSession.send("Emulation.setEmulatedMedia", { features });
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
        .locator(POPOVER)
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
    .locator(POPOVER)
    .waitFor({ state: "visible", timeout: 8000 })
    .catch(() => {});
  await settle(page, 500);
}

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
 * this the harness happily captures an empty inbox — the silent-wrong-artifact
 * failure that sends a whole review off reasoning about a screen that doesn't
 * exist.
 */
async function assertSeeded(page: Page, minRows: number): Promise<void> {
  const rows = page.locator(SEL.notifications.centerList).locator(SEL.notifications.centerRow);
  const count = await rows.count();
  if (count < minRows) {
    throw new Error(`expected at least ${minRows} inbox rows on screen, saw ${count}`);
  }
}

/**
 * The numbers behind the two claims a picture argues about but can't settle:
 * whether the list is reachable to its end, and whether the bands of chrome
 * down the panel share a left edge.
 *
 * Measured live in the page rather than inferred from the class names, because
 * the whole point is to catch the case where the classes say one thing and the
 * box model does another.
 */
async function measure(page: Page, label: string): Promise<void> {
  const data = await page.evaluate(
    ({ popoverSel, listSel, rowSel, pillSel }) => {
      const round = (n: number) => Math.round(n * 10) / 10;
      const popover = document.querySelector(popoverSel) as HTMLElement | null;
      const list = document.querySelector(listSel) as HTMLElement | null;
      if (!popover) return { error: "no popover" };

      const pBox = popover.getBoundingClientRect();
      // The scrollport is the element that actually scrolls, which is not
      // necessarily the one carrying role=list — find it by overflow.
      let scroller: HTMLElement | null = list;
      while (scroller && scroller !== popover) {
        const oy = getComputedStyle(scroller).overflowY;
        if (oy === "auto" || oy === "scroll") break;
        scroller = scroller.parentElement;
      }
      if (scroller === popover) scroller = null;

      const rows = Array.from(document.querySelectorAll(rowSel)) as HTMLElement[];
      const lastRow = rows[rows.length - 1];
      const sBox = scroller?.getBoundingClientRect();

      const insetOf = (el: Element | null | undefined) =>
        el ? round((el as HTMLElement).getBoundingClientRect().left - pBox.left) : null;

      // Left insets of each band of chrome, top to bottom.
      const title = Array.from(popover.querySelectorAll("span")).find(
        (s) => s.textContent?.trim() === "Notifications"
      );
      // The group-by toggle also carries aria-pressed and lives in the header,
      // so match on the chip's own label rather than the attribute alone — the
      // attribute picked the toggle at x=184 on the first run.
      const firstChip = Array.from(popover.querySelectorAll("button[aria-pressed]")).find(
        (b) => b.textContent?.trim() === "All"
      ) as HTMLElement | undefined;
      const pill = document.querySelector(pillSel);
      const sectionLabel = Array.from(popover.querySelectorAll("div")).find(
        (d) =>
          d.children.length === 0 &&
          /^(Needs attention|Earlier|Today|Yesterday)$/i.test(d.textContent?.trim() ?? "")
      );
      // A row's TEXT, not the full-bleed row box — the box is edge to edge by
      // construction, so its inset says nothing about whether the type aligns.
      const firstRowTitle = rows[0]?.querySelector("span, h3, div[class*='font-']");

      return {
        window: { w: window.innerWidth, h: window.innerHeight },
        popover: {
          w: round(pBox.width),
          h: round(pBox.height),
          top: round(pBox.top),
          bottom: round(pBox.bottom),
          // How much of the window's height the panel is willing to use.
          shareOfWindowHeight: round((pBox.height / window.innerHeight) * 100),
        },
        scrollport: scroller
          ? {
              clientHeight: round(scroller.clientHeight),
              scrollHeight: round(scroller.scrollHeight),
              scrollTop: round(scroller.scrollTop),
              // >0 means there is still list below the fold.
              remainingBelow: round(
                scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
              ),
              tabIndex: scroller.tabIndex,
              share: sBox ? round((sBox.height / pBox.height) * 100) : null,
            }
          : null,
        // The clipping claim, as a number. Negative = the last row's bottom sits
        // below the scrollport's bottom, i.e. it is cut off right now.
        lastRow:
          lastRow && sBox
            ? {
                height: round(lastRow.getBoundingClientRect().height),
                bottomGap: round(sBox.bottom - lastRow.getBoundingClientRect().bottom),
              }
            : null,
        rowCount: rows.length,
        // The alignment claim, as numbers. These should agree.
        leftInsets: {
          title: insetOf(title),
          filterChipBox: insetOf(firstChip),
          filterChipText: firstChip
            ? round(
                firstChip.getBoundingClientRect().left -
                  pBox.left +
                  parseFloat(getComputedStyle(firstChip).paddingLeft || "0")
              )
            : null,
          mutedPill: insetOf(pill?.querySelector("span")),
          sectionLabel: insetOf(sectionLabel),
          rowBox: insetOf(rows[0]),
          rowTitle: insetOf(firstRowTitle),
        },
        // Why the scrollport is the size it is. Walk from the scroller up to
        // the popover and report what each ancestor contributes, because
        // "max-height doesn't reach the scroll child" is a chain failure and
        // the chain is the only thing that can name which link broke.
        chain: (() => {
          const out: unknown[] = [];
          let el: HTMLElement | null = scroller ?? list;
          while (el && el !== popover.parentElement) {
            const cs = getComputedStyle(el);
            out.push({
              tag: el.tagName.toLowerCase(),
              testid: el.getAttribute("data-testid") ?? undefined,
              cls: el.className?.toString().slice(0, 90),
              height: round(el.getBoundingClientRect().height),
              computedHeight: cs.height,
              maxHeight: cs.maxHeight,
              minHeight: cs.minHeight,
              flex: cs.flex,
              display: cs.display,
              overflowY: cs.overflowY,
            });
            el = el.parentElement;
          }
          return out;
        })(),
        // What the intrinsic-size guess is actually worth: the spread between
        // the shortest and tallest row against the 72px the code assumes.
        rowHeights: {
          assumedIntrinsic: 72,
          min: rows.length
            ? round(Math.min(...rows.map((r) => r.getBoundingClientRect().height)))
            : null,
          max: rows.length
            ? round(Math.max(...rows.map((r) => r.getBoundingClientRect().height)))
            : null,
        },
      };
    },
    {
      popoverSel: POPOVER,
      listSel: SEL.notifications.centerList,
      rowSel: `${POPOVER} ${SEL.notifications.centerRow}`,
      pillSel: MUTED_PILL,
    }
  );
  geometry[label] = data;
  console.warn(`[notifcenter-shots] geometry:${label} ${JSON.stringify(data)}`);
}

/**
 * The scrollport must be BOUNDED BY THE PANEL, not sized by its own content.
 *
 * This is the regression gate for #12061, and it is deliberately expressed as
 * a relationship rather than a number: whatever the panel's height turns out
 * to be, the scrollport has to be smaller than it, and a fixture that overflows
 * has to produce something to scroll. The original defect passed every visual
 * check — the panel looked right and the rows looked right — and showed up only
 * here, as a scrollport three times taller than the panel containing it.
 */
async function assertScrollportIsBounded(page: Page, label: string): Promise<void> {
  const result = await page.evaluate(
    ({ popoverSel, listSel }) => {
      const popover = document.querySelector(popoverSel) as HTMLElement | null;
      const list = document.querySelector(listSel) as HTMLElement | null;
      if (!popover || !list) return { ok: false, why: "popover or list not found" };
      let scroller: HTMLElement | null = list;
      while (scroller && scroller !== popover) {
        const oy = getComputedStyle(scroller).overflowY;
        if (oy === "auto" || oy === "scroll") break;
        scroller = scroller.parentElement;
      }
      if (!scroller || scroller === popover) return { ok: false, why: "no scrollport found" };
      const panelH = popover.getBoundingClientRect().height;
      const { clientHeight, scrollHeight } = scroller;
      if (clientHeight > panelH) {
        return {
          ok: false,
          why: `scrollport (${Math.round(clientHeight)}px) is taller than the panel (${Math.round(panelH)}px) — its height is coming from content, not from the panel`,
        };
      }
      if (scrollHeight <= clientHeight) {
        return {
          ok: false,
          why: `scrollHeight (${Math.round(scrollHeight)}px) does not exceed clientHeight (${Math.round(clientHeight)}px) — the fixture overflows, so there should be something to scroll`,
        };
      }
      return { ok: true, why: "" };
    },
    { popoverSel: POPOVER, listSel: SEL.notifications.centerList }
  );
  if (!result.ok) throw new Error(`scrollport not bounded (${label}): ${result.why}`);
}

/** Scroll the inbox scrollport to its very bottom and report where it landed. */
async function scrollListToBottom(page: Page): Promise<void> {
  // Scroll in steps rather than one jump. With `content-visibility: auto` the
  // scrollHeight grows as rows are rendered for the first time, so a single
  // assignment to a stale scrollHeight lands short of the real bottom — which
  // is itself the defect under review, and would silently produce a shot of
  // the middle of the list captioned "the bottom".
  await page.evaluate(
    async ({ listSel }) => {
      const list = document.querySelector(listSel) as HTMLElement | null;
      let scroller: HTMLElement | null = list;
      while (scroller) {
        const oy = getComputedStyle(scroller).overflowY;
        if (oy === "auto" || oy === "scroll") break;
        scroller = scroller.parentElement;
      }
      if (!scroller) throw new Error("no scrollport found");
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      for (let i = 0; i < 40; i++) {
        const before = scroller.scrollTop;
        scroller.scrollTop = scroller.scrollHeight;
        await frame();
        await frame();
        if (Math.abs(scroller.scrollTop - before) < 1 && i > 2) break;
      }
    },
    { listSel: SEL.notifications.centerList }
  );
  await settle(page, 400);
}

async function setWindowSize(ctx: AppContext, width: number, height: number): Promise<void> {
  await ctx.app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.setSize(size.width, size.height);
    },
    { width, height }
  );
}

const SPOT_THEMES = ["daintree", "namib", "svalbard"];

test("notification center review — scrollport, rhythm, and chrome", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_NOTIFCENTER is required for the inbox popover capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_NOTIFCENTER to run the inbox popover capture");

  failures.length = 0;
  mediaSession = null;

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-notifcentershot-"));
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
    await seedNotificationHistory(page, buildFixture(now));
    await reopenCenter(page);
    await assertSeeded(page, 6);

    // 1. Rest — the panel as it opens, and the same panel inside the window it
    //    is allowed to use. The second shot is the whole point of the sizing
    //    question: a 360x420 box on a 1680x1050 display.
    await step(page, "rest", async () => {
      await assertSeeded(page, 6);
      await measure(page, "rest");
      await snap(page, "10-rest-popover", POPOVER);
      await snap(page, "11-rest-window");
    });

    // 2. Scrolled to the bottom. The issue's primary claim lives here: whether
    //    the last row arrives whole, and whether the scrollport agrees with
    //    itself about where the bottom is.
    await step(page, "scroll", async () => {
      await scrollListToBottom(page);
      await measure(page, "scrolled-to-bottom");
      await snap(page, "20-scrolled-bottom-popover", POPOVER);
      await snap(page, "21-scrolled-bottom-window");
      // The regression gate. Asserted AFTER the shots so a failure still leaves
      // the evidence on disk rather than aborting with nothing to look at.
      await assertScrollportIsBounded(page, "scrolled-to-bottom");
    });

    // 3. An action-carrying row at the fold — the worst case the issue names,
    //    where what gets cut off is a button rather than a word.
    await step(page, "actions", async () => {
      // Scroll the LIST, not whatever ancestor the browser decides is
      // scrollable. `scrollIntoViewIfNeeded` on the first run scrolled an
      // ancestor and dragged the whole popover 737px off the top of the
      // window — which is itself a symptom: the browser looked for a
      // scrollable ancestor because the list is not one.
      await page.evaluate(
        ({ listSel, rowSel }) => {
          const list = document.querySelector(listSel) as HTMLElement | null;
          if (!list) return;
          const row = Array.from(list.querySelectorAll(rowSel)).find((r) =>
            r.textContent?.includes("idle for 30 minutes")
          ) as HTMLElement | undefined;
          let scroller: HTMLElement | null = list;
          while (scroller) {
            const oy = getComputedStyle(scroller).overflowY;
            if (oy === "auto" || oy === "scroll") break;
            scroller = scroller.parentElement;
          }
          if (!row || !scroller) return;
          scroller.scrollTop =
            row.offsetTop - scroller.clientHeight + row.getBoundingClientRect().height + 8;
        },
        { listSel: SEL.notifications.centerList, rowSel: SEL.notifications.centerRow }
      );
      await settle(page, 300);
      await measure(page, "action-row-at-fold");
      await snap(page, "30-action-row-popover", POPOVER);
    });

    // 4. The mute pill, driven through the real Pause menu rather than a
    //    backdoor — the pill's copy is derived from the live gate state, so
    //    faking the state would fake the string it is being judged on.
    await step(page, "muted", async () => {
      await page.locator('button[aria-label="Pause notifications"]').first().click();
      await settle(page, 400);
      // The Pause menu itself is chrome worth seeing, and capturing it here
      // also proves the menu opened at all when the step downstream fails.
      await snap(page, "39-pause-menu-window");
      await page.locator('[role="menuitem"]', { hasText: "For 1 hour" }).first().click();
      await settle(page, 600);
      // Selecting a mute duration may dismiss the popover along with the menu,
      // so reopen before looking for the pill rather than timing out on a
      // panel that is no longer on screen.
      if (
        !(await page
          .locator(MUTED_PILL)
          .isVisible()
          .catch(() => false))
      ) {
        await reopenCenter(page);
      }
      await page.locator(MUTED_PILL).waitFor({ state: "visible", timeout: 8000 });
      await measure(page, "muted");
      await snap(page, "40-muted-popover", POPOVER);
      await snap(page, "41-muted-pill", MUTED_PILL);
      await scrollListToBottom(page);
      await measure(page, "muted-scrolled-bottom");
      await snap(page, "42-muted-scrolled-bottom-popover", POPOVER);
    });

    // 5. Group by context — adds another band of chrome to the left edge, so
    //    it is where an inconsistent inset shows up most clearly.
    await step(page, "grouped", async () => {
      await page.locator('button[aria-label="Group by project or worktree"]').first().click();
      await settle(page, 500);
      await measure(page, "grouped");
      await snap(page, "50-grouped-popover", POPOVER);
      await page.locator('button[aria-label="Group by project or worktree"]').first().click();
      await settle(page, 300);
    });

    // 6. The other tabs. Archived and Unread change what the list holds
    //    without changing the chrome around it.
    await step(page, "filters", async () => {
      await page.locator(SEL.notifications.centerFilter("Unread")).first().click();
      await settle(page, 400);
      await snap(page, "60-unread-popover", POPOVER);
      await page.locator(SEL.notifications.centerFilter("Archived")).first().click();
      await settle(page, 400);
      await snap(page, "61-archived-popover", POPOVER);
    });

    // 7. Empty — the floor of the surface, and the one state where the fixed
    //    chrome is the entire panel.
    await step(page, "empty", async () => {
      await seedNotificationHistory(page, []);
      await reopenCenter(page);
      // Empty WHILE muted first — this is the state where the pill and the
      // empty-state body both explain the same silence, so it is the one that
      // shows whether they are saying it twice.
      if (
        await page
          .locator(MUTED_PILL)
          .isVisible()
          .catch(() => false)
      ) {
        await measure(page, "empty-muted");
        await snap(page, "70-empty-muted-popover", POPOVER);
        // Resume, so the next shot is the ordinary empty state rather than an
        // inherited mute from the earlier step.
        await page.locator('button[aria-label="Resume notifications"]').first().click();
        await settle(page, 500);
        await reopenCenter(page);
      }
      await measure(page, "empty");
      await snap(page, "71-empty-popover", POPOVER);
      await seedNotificationHistory(page, buildFixture(now));
      await reopenCenter(page);
    });

    // 8. Viewport — the same panel on a laptop window and on a large one. If
    //    the box never changes, these two shots say so better than the class
    //    name does.
    await step(page, "viewport", async () => {
      await setWindowSize(ctx!, 1280, 800);
      await settle(page, 800);
      await reopenCenter(page);
      await measure(page, "window-1280x800");
      await snap(page, "80-laptop-window");
      await snap(page, "81-laptop-popover", POPOVER);

      await setWindowSize(ctx!, 2200, 1300);
      await settle(page, 800);
      await reopenCenter(page);
      await measure(page, "window-2200x1300");
      await snap(page, "82-large-window");
      await snap(page, "83-large-popover", POPOVER);

      await setWindowSize(ctx!, 1680, 1050);
      await settle(page, 800);
    });

    // 9. prefers-contrast: more (macOS "Increase contrast").
    await step(page, "contrast", async () => {
      await setMediaFeatures(page, [{ name: "prefers-contrast", value: "more" }]);
      await settle(page, 400);
      await snap(page, "90-high-contrast-popover", POPOVER);
    });

    // 10. forced-colors: active (Windows high contrast). The panel's own
    //     background and the scroll cue are what collapse here.
    await step(page, "forced", async () => {
      await page.emulateMedia({ forcedColors: "active" });
      await settle(page, 500);
      if (!(await page.evaluate(() => matchMedia("(forced-colors: active)").matches))) {
        throw new Error("forced-colors emulation did not apply");
      }
      await snap(page, "91-forced-colors-popover", POPOVER);
    });

    // 11. A theme spot check. The panel leans on overlay and divider tokens,
    //     which are the ones that diverge most across palettes.
    await step(page, "themes", async () => {
      for (const [i, theme] of SPOT_THEMES.entries()) {
        // `setAppTheme` reloads the page, which drops the seeded history, so
        // re-seed after each switch. Without this the theme shots are taken
        // against whatever rehydrated from disk rather than the fixture, and a
        // palette comparison across different content is not a comparison.
        await setAppTheme(page, theme);
        await settle(page, 600);
        await dismissBlockingPalette(page);
        await seedNotificationHistory(page, buildFixture(now));
        await reopenCenter(page);
        await assertSeeded(page, 6);
        await snap(page, `95-theme-${i}-${theme}-popover`, POPOVER);
      }
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

  if (Object.keys(geometry).length > 0) {
    writeFileSync(
      path.join(OUTPUT_DIR, `geometry${TAG}.json`),
      JSON.stringify(geometry, null, 2),
      "utf8"
    );
  }

  const written = existsSync(OUTPUT_DIR)
    ? readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(`${TAG}.png`)).length
    : 0;
  console.warn(`[notifcenter-shots] wrote ${written} png(s) to ${OUTPUT_DIR}`);

  if (failures.length > 0) {
    throw new Error(
      `[notifcenter-shots] ${failures.length} step(s) failed:\n${failures.join("\n")}`
    );
  }
  if (written === 0) {
    throw new Error(`[notifcenter-shots] no PNGs written to ${OUTPUT_DIR}`);
  }
});
