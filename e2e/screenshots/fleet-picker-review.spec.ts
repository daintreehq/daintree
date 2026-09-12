/**
 * Fleet picker visual-review harness — the "Select terminals to arm" palette.
 *
 * `palette-review.spec.ts` deliberately skips this surface ("palettes that need
 * a seeded state to render anything"), so it has never been reviewed against
 * rendered pixels. That seeding is the whole cost of this spec: the picker reads
 * `usePanelStore` for grid PTY panels, groups them by worktree, and renders a
 * Waiting/Working badge off `agentState` — a state only the real FSM produces.
 * So the fixture builds real linked worktrees, launches real fake-claude
 * sessions in them, and drives one past its heartbeat. Nothing here is a UI-level
 * mock; a mocked row would review a surface the app never paints.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_THEME is set, so neither the
 * marketing screenshots workflow nor a bare `--project=screenshots` run executes
 * it.
 *
 *   DAINTREE_SHOT_THEME=daintree npx playwright test --project=screenshots fleet-picker-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_THEME  required — theme id to render (e.g. daintree, namib)
 *   DAINTREE_SHOT_TAG    optional suffix to keep before/after rounds side by side
 *   DAINTREE_SHOT_ONLY   comma-separated step filter (see step names below)
 *   DAINTREE_SHOT_DIR    output directory override (the design-review loop uses this)
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 2)
 *
 * Output: <dir>/<theme>/<NN-slug>[-tag].png. Defaults to artifacts/fleet-picker-shots/
 * (gitignored) — never into the working tree.
 */

import { expect, test, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { getGridPanelIds } from "../helpers/panels";
import { getTerminalText, waitForTerminalText, writeTerminalInput } from "../helpers/terminal";
import {
  installFakeAgent,
  fakeAgentEnv,
  ptyWrite,
  FAKE_AGENT_READY,
  FAKE_AGENT_IDLE,
} from "../helpers/fakeAgent";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = path.join(
  process.env.DAINTREE_SHOT_DIR
    ? path.resolve(process.env.DAINTREE_SHOT_DIR)
    : path.resolve(process.cwd(), "artifacts", "fleet-picker-shots"),
  THEME || "unset"
);

const PICKER = '[role="dialog"][aria-label="Select terminals to arm"]';
const ZAP = 'button[aria-label="Select terminals to arm"]';
/** Inside `group/header` — hovering it reveals the header's hidden button cluster. */
const SIDEBAR_HEADING = 'h2:text-is("Worktrees")';
const TID = "fleet-picker-cold-start";

/**
 * Freeze animations and hide carets. The palette zooms on entry and the
 * segmented thumb slides between Replace and Append; a mid-transition frame
 * reads as a design flaw that isn't there.
 */
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

/**
 * Four worktrees whose branch names span the range the picker has to render:
 * a long prefixed feature branch that will compete with the row's right-hand
 * column for width, a bare branch with no prefix, and two ordinary ones.
 */
const WORKTREES = [
  { branch: "feature/native-daintree-assistant", slug: "native-assistant" },
  { branch: "feature/theme-selector-design", slug: "theme-selector" },
  { branch: "fix/retry-backoff-jitter", slug: "retry-backoff" },
] as const;

/**
 * Agents launch here in order; the last one is driven to `waiting`.
 *
 * The first worktree deliberately gets TWO agents. A group of one can never be
 * partially selected, and the tri-state group checkbox is the single hardest
 * glyph on this surface to get right — with one agent per worktree it would
 * never render at all.
 */
const AGENT_BRANCHES = [
  WORKTREES[0].branch,
  WORKTREES[0].branch,
  WORKTREES[1].branch,
  WORKTREES[2].branch,
] as const;

/** A plain shell, so one row carries no state badge and "Select agents" means something. */
const PLAIN_TERMINAL_BRANCH = WORKTREES[1].branch;

function createRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-fleetpicker-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(
    path.join(dir, "src", "index.ts"),
    "export async function startCheckout(cartId: string): Promise<string> {\n  return cartId;\n}\n"
  );
  git("add -A", dir);
  git('commit -m "initial commit"', dir);

  for (const wt of WORKTREES) {
    git(`worktree add -b ${wt.branch} ${JSON.stringify(path.join(wtRoot, wt.slug))} main`, dir);
  }

  return {
    dir,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/**
 * Clip to the picker plus a margin so the capture carries the surface edge, its
 * shadow and the scrim behind it — the three things that make a floating surface
 * read as elevated. An element screenshot crops exactly at the border and hides
 * all of it.
 */
async function snapSurface(page: Page, slug: string, selector = PICKER, pad = 48): Promise<void> {
  await settle(page);
  const box = await page.locator(selector).first().boundingBox();
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  if (!box) throw new Error(`no bounding box for ${selector} — nothing to capture for "${slug}"`);
  const viewport = page.viewportSize() ?? { width: 1680, height: 1050 };
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  await page.screenshot({
    path: file,
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: {
      x,
      y,
      width: Math.min(box.width + pad * 2, viewport.width - x),
      height: Math.min(box.height + pad * 2, viewport.height - y),
    },
  });
}

/**
 * Run a capture step. A failure never stops the remaining shots — one missing
 * state should not cost the whole sweep — but it IS recorded and the test fails
 * at the end. Swallowing outright made a run that captured nothing report green.
 */
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const stepFailures: string[] = [];
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).split("\n")[0];
    console.warn(`[fleet-picker-shots] step "${name}" FAILED:`, detail);
    stepFailures.push(`${name}: ${detail}`);
  }
}

async function dispatch(page: Page, actionId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const fn = window.__daintreeDispatchAction;
    if (typeof fn !== "function") throw new Error("Action dispatch hook not available");
    await fn(id, undefined, { source: "test" });
  }, actionId);
}

/**
 * Switch the active worktree through the overview modal. The picker groups by
 * worktree and an agent launches into whichever worktree is active, so this is
 * what spreads sessions across groups — and grouping is the main thing being
 * reviewed here.
 *
 * Going via the sidebar list looks simpler and is wrong: it is virtualized, and
 * a click that lands on a card there selects it for the filter without making
 * it active. The first version of this spec did that and put all three agents
 * in one group, which collapsed the picker into its single-worktree layout and
 * captured a surface with no hierarchy at all.
 */
async function activateWorktree(page: Page, branch: string): Promise<void> {
  await dismissBlockingPalette(page).catch(() => {});
  await dispatch(page, "worktree.overview.open");
  const modal = page.locator(SEL.worktree.overviewModal);
  await modal.waitFor({ state: "visible", timeout: T_LONG });
  // `data-worktree-branch` carries the DERIVED label, which drops the type
  // prefix — `feature/theme-selector-design` renders as `theme-selector-design`.
  // Match the suffix, or the locator can never resolve.
  const leaf = branch.split("/").pop() ?? branch;
  const cell = page
    .locator(`${SEL.worktree.overviewCell}:has([data-worktree-branch$="${leaf}"])`)
    .first();
  await cell.waitFor({ state: "visible", timeout: T_LONG });
  await cell.click();
  await modal.waitFor({ state: "hidden", timeout: T_LONG }).catch(() => {});
  await settle(page, 800);
}

/**
 * Launch one fake-claude session in the active worktree and drive it past the
 * trust prompt, so the agent-state FSM reaches `working` for real.
 */
async function launchAgentSession(page: Page): Promise<string | null> {
  const before = new Set(await getGridPanelIds(page));
  await dismissBlockingPalette(page).catch(() => {});
  await page
    .locator(SEL.agent.trayButton)
    .first()
    .click()
    .catch(() => {});
  await page
    .locator(SEL.agent.launcherRow("Claude"))
    .first()
    .click()
    .catch(() => {});

  let panelId: string | null = null;
  for (let i = 0; i < 60 && !panelId; i++) {
    const ids = await getGridPanelIds(page).catch(() => [] as string[]);
    panelId = ids.find((id) => !before.has(id)) ?? null;
    if (!panelId) await page.waitForTimeout(250);
  }
  if (!panelId) return null;

  const panel = page.locator(`[data-panel-id="${panelId}"]`);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const text = (await getTerminalText(panel).catch(() => "")).toLowerCase();
    if (text.includes(FAKE_AGENT_READY.toLowerCase())) break;
    if (text.includes("enter to confirm") || text.includes("trust this folder")) {
      await writeTerminalInput(page, panel, "\r").catch(() => {});
      break;
    }
    await page.waitForTimeout(250);
  }
  await waitForTerminalText(panel, FAKE_AGENT_READY, T_LONG).catch(() => {});
  return panelId;
}

/**
 * One agent per worktree, and the last one idled so its row renders `Waiting`
 * next to the others' `Working`.
 *
 * FAKE_AGENT_IDLE, not FAKE_AGENT_STOP: stop exits the process, which flips
 * `runtimeStatus` to "exited" and makes the terminal fleet-INELIGIBLE — the row
 * would vanish from the very list being captured. Idle stops the heartbeat and
 * leaves the PTY alive, which is what a real agent handing back looks like.
 */
async function seedFleet(page: Page): Promise<void> {
  const launched: string[] = [];
  let active = "";
  for (const branch of AGENT_BRANCHES) {
    // Two agents in a row share a worktree; switching to the one already active
    // round-trips the overview modal for nothing.
    if (branch !== active) {
      await activateWorktree(page, branch);
      active = branch;
    }
    const id = await launchAgentSession(page);
    if (id) launched.push(id);
  }

  // TWO plain shells in one worktree. They do two jobs: a row with no state
  // badge (so "Select agents" means something and the badge column has a gap
  // to cope with), and — because they share a worktree — a group with siblings,
  // which is the only way the tri-state group checkbox can ever render.
  //
  // Plain terminals rather than more agents on purpose: an agent launch is a
  // CLI spawn plus a trust prompt plus an FSM settle, and the earlier ones in
  // this fixture do not reliably survive to the end of the run.
  if (PLAIN_TERMINAL_BRANCH !== active) {
    await activateWorktree(page, PLAIN_TERMINAL_BRANCH);
  }
  for (let i = 0; i < 2; i++) {
    await dismissBlockingPalette(page).catch(() => {});
    await page
      .locator(SEL.toolbar.openTerminal)
      .first()
      .click()
      .catch(() => {});
    await settle(page, 1500);
  }

  // The panel this launch actually produced, not whichever id sorts last —
  // `getGridPanelIds` is not launch-ordered, and idling the wrong pane leaves
  // every row reading `Working`.
  const target = launched[launched.length - 1];
  if (target) {
    // `ptyWrite` goes straight to the PTY. `writeTerminalInput` routes through
    // the focused xterm instance, which is not this pane after three launches.
    await ptyWrite(page, target, `${FAKE_AGENT_IDLE}\r`);
    const panel = page.locator(`[data-panel-id="${target}"]`);
    await expect
      .poll(() => panel.getAttribute("data-agent-state"), {
        timeout: T_LONG * 3,
        intervals: [500, 1000],
      })
      .toBe("waiting")
      .catch(() => {});
    const reached = await panel.getAttribute("data-agent-state").catch(() => null);
    if (reached !== "waiting") {
      // Non-fatal, but say so loudly: the Waiting badge is one of the things
      // being reviewed, and a sweep that silently shows three `Working` rows
      // would be reviewed as if that were the design.
      console.warn(
        `[fleet-picker-shots] WARNING: agent settled on "${reached}", not "waiting" — no Waiting badge in this sweep`
      );
    }
  }
  await settle(page, 900);
}

/**
 * The Zap button is the only way into this surface, and it lives inside a
 * wrapper that is `invisible opacity-0 pointer-events-none` until the sidebar
 * header is hovered or focused (`group-hover/header` / `group-focus-within`).
 * So the hover is mandatory, not incidental: without it Playwright waits on an
 * element that never becomes actionable and the whole sweep times out one step
 * at a time.
 */
async function openPicker(page: Page): Promise<void> {
  if (await page.locator(PICKER).isVisible().catch(() => false)) return;
  await dismissBlockingPalette(page).catch(() => {});
  await page.locator(SIDEBAR_HEADING).first().hover();
  await settle(page, 200);
  const zap = page.locator(ZAP).first();
  await zap.waitFor({ state: "visible", timeout: T_LONG });
  await zap.click();
  await page.locator(PICKER).waitFor({ state: "visible", timeout: T_LONG });
  await settle(page, 400);
}

async function closePicker(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await settle(page, 200);
  await page.keyboard.press("Escape").catch(() => {});
  await page
    .locator(PICKER)
    .waitFor({ state: "hidden", timeout: 5000 })
    .catch(() => {});
  await settle(page, 200);
}

/** Reopen from scratch so each step starts from the picker's own initial state. */
async function reopenPicker(page: Page): Promise<void> {
  await closePicker(page);
  await openPicker(page);
}

async function setQuery(page: Page, q: string): Promise<void> {
  const input = page.locator(`[data-testid="${TID}-search"]`);
  await input.fill(q);
  await settle(page, 500);
}

test("fleet picker review — every state that carries design weight", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_THEME is required for the fleet-picker-review capture",
  });
  test.skip(!THEME, "Set DAINTREE_SHOT_THEME to run the fleet-picker-review capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createRepo();
  const fakeBinDir = installFakeAgent(repo.dir);
  // Prefix deliberately avoids "daintree-e2e" — launchApp's pre-launch hygiene
  // pkills that pattern, and parallel theme captures would SIGKILL each other.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-fleetpickershot-"));
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      env: fakeAgentEnv(fakeBinDir),
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await page.evaluate(async () => {
      const cur = await window.electron.project.getCurrent();
      if (cur?.id)
        await window.electron.project.update(cur.id, { emoji: "☀️", name: "Helios Dashboard" });
    });
    await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await settle(page, 2000);

    await seedFleet(page);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});

    // 1. Rest — the state the sidebar Zap opens into. Cold-start pre-selects the
    //    active worktree's eligibles, so this also shows a partially-selected
    //    tree: one group checked, the rest empty. The headline state.
    await step("rest", async () => {
      await openPicker(page);
      // The grouped, two-level layout IS the surface under review. When every
      // terminal lands in one worktree the picker hides its group headers
      // entirely (`isSingleWorktree`), and the sweep would quietly document a
      // flat list as though that were the design. Fail loudly instead.
      const groups = await page.locator(`[data-testid^="${TID}-group-"]`).count();
      expect(groups, "fixture produced one group — the picker collapsed to its single-worktree layout").toBeGreaterThan(1);
      await snapSurface(page, "10-rest");
    });

    // 2. Nothing selected — the disabled primary and its "Arm selected" copy.
    await step("empty-selection", async () => {
      await openPicker(page);
      // "Clear" is its own control now — the bulk actions no longer share one
      // button whose label reverses, so there is nothing to click twice.
      await page.locator(`[data-testid="${TID}-clear-selection"]`).click();
      await settle(page, 300);
      await snapSurface(page, "11-empty-selection");
    });

    // 3. Everything selected — every group's count full, every checkbox checked,
    //    and the primary carrying the largest count it will ever show here.
    await step("all-selected", async () => {
      await openPicker(page);
      await page.locator(`[data-testid="${TID}-select-all"]`).click();
      await settle(page, 300);
      await snapSurface(page, "12-all-selected");
    });

    // 4. Indeterminate — the tri-state group checkbox, which is the single
    //    hardest glyph on this surface to get right and is invisible in any
    //    state where selection is all-or-nothing.
    await step("indeterminate", async () => {
      await reopenPicker(page);
      await page.locator(`[data-testid="${TID}-select-all"]`).click();
      await settle(page, 250);
      // Deselect one row inside a group that has siblings, so that group falls
      // to `indeterminate`. Picking "the first row" would not do: if it belongs
      // to a single-terminal group the group just goes unchecked and the
      // tri-state glyph never renders.
      const sections = page.locator(`[data-testid="${TID}-list"] section[role="group"]`);
      const count = await sections.count();
      let toggled = false;
      for (let i = 0; i < count; i++) {
        const rows = sections.nth(i).locator(`[data-testid^="${TID}-row-"]`);
        if ((await rows.count()) > 1) {
          await rows.first().click();
          toggled = true;
          break;
        }
      }
      expect(toggled, "no group had two terminals — cannot produce an indeterminate checkbox").toBe(
        true
      );
      await settle(page, 300);
      await expect(page.locator('[data-state="indeterminate"]').first()).toBeVisible();
      await snapSurface(page, "13-indeterminate");
    });

    // 5. Search active — filtered rows, and whether a narrowed list still reads
    //    as grouped. Also the `isSingleWorktree` path: when the query collapses
    //    the result to one worktree the group headers are suppressed entirely.
    await step("search", async () => {
      await reopenPicker(page);
      await setQuery(page, "theme");
      await snapSurface(page, "14-search");
    });

    // 6. Filtered to nothing — the "No terminals match" empty state, sized
    //    against a dialog that was tall a moment ago.
    await step("search-empty", async () => {
      await reopenPicker(page);
      await setQuery(page, "zzzznomatch");
      await snapSurface(page, "15-search-empty");
    });

    // 7. Append mode — the segmented thumb on the far option and the primary
    //    relabelled to "Add N", which is a different word at a different width.
    await step("append-mode", async () => {
      await reopenPicker(page);
      await page.locator(`[data-testid="${TID}-commit-mode-append"]`).click();
      await settle(page, 300);
      await snapSurface(page, "16-append-mode");
    });

    // 8. Shortcuts popover — the "?" affordance in the hint strip, and the only
    //    place the full keyboard contract is stated.
    await step("shortcuts-popover", async () => {
      await reopenPicker(page);
      await page.locator('[aria-label="More keyboard shortcuts"]').click();
      await settle(page, 400);
      await snapSurface(page, "17-shortcuts-popover");
    });

    // 9. Row focus — the keyboard path the footer advertises. Arrow into the
    //    list so a row carries the focus ring, which is the affordance a
    //    keyboard-first surface is judged on.
    await step("row-focus", async () => {
      await reopenPicker(page);
      await page.keyboard.press("ArrowDown");
      await settle(page, 200);
      await page.keyboard.press("ArrowDown");
      await settle(page, 300);
      await snapSurface(page, "18-row-focus");
    });

    await closePicker(page);

    // Never trust the exit code — count the files. A harness that reports PASS
    // while producing nothing is worse than one that fails.
    const written = existsSync(OUTPUT_DIR)
      ? readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png"))
      : [];
    console.log(`[fleet-picker-shots] wrote ${written.length} PNG(s) to ${OUTPUT_DIR}`);
    expect(stepFailures, `capture steps failed:\n${stepFailures.join("\n")}`).toEqual([]);
    expect(written.length, "no PNGs were written").toBeGreaterThan(0);
  } finally {
    if (ctx?.app) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
