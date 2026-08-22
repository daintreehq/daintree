/**
 * Interactive theme tour.
 *
 * Boots the app on a rich multi-worktree fixture, applies a theme, and then
 * HANDS THE WINDOW OVER. A control panel injected into the renderer lists the
 * surfaces worth judging; clicking one drives the real app into that state.
 * The window stays open until the reviewer presses "finish", so this is for
 * looking at a theme, not for asserting anything about it.
 *
 * Companion to `theme-review.spec.ts`, which captures the same surfaces as PNGs.
 * Use that one for a record, this one for a verdict.
 *
 *   npm run theme:tour                 # movile, compared against daintree
 *   DAINTREE_TOUR_THEME=namib npm run theme:tour
 *   DAINTREE_TOUR_COMPARE=redwoods npm run theme:tour
 *
 * The tour has no assertions and never fails on purpose — the point is the
 * pixels. It is opt-in via DAINTREE_TOUR, so a bare `--project=screenshots`
 * run (the marketing pipeline) skips it.
 */

import { test, expect, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { BUILT_IN_APP_SCHEMES } from "../../shared/theme/index.js";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { installTourHud, type TourSceneMeta, type TourState } from "../helpers/themeTour";
import {
  installFakeAgent,
  fakeAgentEnv,
  ptyWrite,
  FAKE_AGENT_IDLE,
  FAKE_AGENT_READY,
} from "../helpers/fakeAgent";
import {
  getTerminalText,
  getTerminalSelection,
  waitForTerminalText,
  writeTerminalInput,
} from "../helpers/terminal";
import { getDockChipIds, getGridPanelIds } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = process.env.DAINTREE_TOUR === "1";
const THEME = process.env.DAINTREE_TOUR_THEME ?? "movile";
const COMPARE = process.env.DAINTREE_TOUR_COMPARE ?? "daintree";
// Walk every scene unattended, writing a PNG per scene, then exit. Same scenes,
// same fixture, no reviewer — so an asynchronous review reads exactly what an
// interactive one would have seen.
const AUTO = process.env.DAINTREE_TOUR_AUTO === "1";
const SHOT_DIR = path.resolve(process.cwd(), "artifacts", "theme-tour", THEME);

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

/**
 * A repo shaped to exercise the things a theme has to get right: several
 * worktrees so the sidebar is full, dirty trees so the review hub and the diff
 * viewer have content, and a source file with enough syntax variety that the
 * highlighting roles are all visible in one screen.
 */
function createTourRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-theme-tour-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(
    path.join(dir, "src", "index.ts"),
    [
      'import { createClient } from "./client";',
      "",
      "// Retry with jittered backoff so a thundering herd can't form.",
      "export const MAX_RETRIES = 3;",
      "",
      "export async function main(): Promise<number> {",
      '  const client = createClient({ endpoint: "https://api.helios.dev", timeout: 5_000 });',
      "  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {",
      "    const result = await client.poll();",
      '    if (result.status === "ready") return 0;',
      "  }",
      "  throw new Error(`gave up after ${MAX_RETRIES} attempts`);",
      "}",
      "",
    ].join("\n")
  );
  git("add -A", dir);
  git('commit -m "initial commit"', dir);

  // Dirty main worktree so the review hub and diff view have real content.
  writeFileSync(
    path.join(dir, "src", "index.ts"),
    [
      'import { createClient } from "./client";',
      "",
      "// Retry with jittered backoff so a thundering herd can't form.",
      "export const MAX_RETRIES = 5;",
      "export const JITTER_MS = 250;",
      "",
      "export async function main(): Promise<number> {",
      '  const client = createClient({ endpoint: "https://api.helios.dev", timeout: 8_000 });',
      "  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {",
      "    const result = await client.poll();",
      '    if (result.status === "ready") return attempt;',
      "    await sleep(JITTER_MS * 2 ** attempt);",
      "  }",
      "  throw new Error(`gave up after ${MAX_RETRIES} attempts`);",
      "}",
      "",
    ].join("\n")
  );
  writeFileSync(path.join(dir, "notes.md"), "# Notes\n\n- movile review pass\n");

  const features = [
    { branch: "feature/oauth-device-flow", dirty: true, commits: 2 },
    { branch: "feature/streaming-tokens", dirty: false, commits: 1 },
    { branch: "fix/retry-backoff-jitter", dirty: true, commits: 3 },
    { branch: "chore/bump-electron-42", dirty: false, commits: 1 },
    { branch: "feature/sulfur-metrics", dirty: true, commits: 2 },
  ];
  for (const f of features) {
    const slug = f.branch.replace(/[/]/g, "-");
    const wtDir = path.join(wtRoot, slug);
    git(`branch ${f.branch}`, dir);
    git(`worktree add ${JSON.stringify(wtDir)} ${f.branch}`, dir);
    for (let i = 0; i < f.commits; i++) {
      writeFileSync(path.join(wtDir, `change-${i}.md`), `change ${i} on ${f.branch}\n`);
      git("add -A", wtDir);
      git(`commit -m "work ${i} on ${slug}"`, wtDir);
    }
    if (f.dirty) {
      writeFileSync(path.join(wtDir, "wip.txt"), "in progress\n");
      writeFileSync(path.join(wtDir, "src", "index.ts"), `// ${slug}\nexport const x = 1;\n`);
    }
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
  await page
    .evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    )
    .catch(() => {});
  await page.waitForTimeout(ms);
}

/** Unwind whatever the previous scene left open. Never throws. */
async function reset(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(120);
  }
  await dismissBlockingPalette(page).catch(() => {});
  await page.mouse.move(900, 640).catch(() => {});
  await settle(page, 250);
}

/**
 * The one command both terminal scenes seed with: every ANSI base slot plus the
 * dim slot, then coloured `git log`/`git status`. Shared so the selection scene
 * can recognise a pane it did not seed itself.
 */
const SEEDED_ANSI_COMMAND =
  "printf '\\e[31mred \\e[32mgreen \\e[33myellow \\e[34mblue \\e[35mmagenta \\e[36mcyan \\e[90mdim\\e[0m\\n'; git log --oneline --color=always | head -4; git status --short";

/**
 * The rendered result of SEEDED_ANSI_COMMAND, not the command itself.
 *
 * Matching on a single word like "magenta" false-positives: the shell echoes the
 * whole `printf` back, so the word is on screen whether or not the command ever
 * ran. Only the space-joined output row proves the ANSI actually painted.
 */
const SEEDED_ANSI_OUTPUT = "red green yellow blue magenta cyan dim";

interface TourScene extends TourSceneMeta {
  run: (page: Page) => Promise<void>;
}

/**
 * Assert, loudly and without failing, that a scene reached the surface its note
 * claims to be showing.
 *
 * The tour has no assertions by design — the point is the pixels, and a scene
 * that throws costs the reviewer the other eighteen. But the failure mode that
 * replaces it is worse: `review-hub` shipped for months capturing a hub whose
 * file list was still collapsed, so the PNG held no diff at all while the
 * scene's note told the reviewer they were looking at diff washes and syntax.
 * A capture that silently asserts a surface it never reached is worse than a
 * missing one, because someone signs it off.
 *
 * So every scene that drives toward something specific ends by checking a
 * postcondition — the thing itself being on screen, not the thing that was
 * supposed to summon it — and says so on the console when it is absent.
 */
async function requireSurface(label: string, present: () => Promise<boolean>): Promise<boolean> {
  const ok = await present().catch(() => false);
  if (!ok) {
    console.warn(
      `[tour] WARNING: "${label}" did not reach its surface — this capture does NOT show what its note claims. Do not review it.`
    );
  }
  return ok;
}

/**
 * Launch the fake Claude and wait until the FSM reports `working`. Returns the
 * panel id so a later scene can stop the heartbeat and let it settle to
 * `waiting` — the state this whole theme is built around.
 */
async function launchWorkingAgent(page: Page): Promise<string | null> {
  const before = new Set(await getGridPanelIds(page));
  await dismissBlockingPalette(page).catch(() => {});
  await page
    .locator(SEL.agent.trayButton)
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
  // Clear the fake CLI's trust prompt, then wait for its ready banner.
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
  await expect
    .poll(() => panel.getAttribute("data-agent-state"), { timeout: T_LONG, intervals: [250, 500] })
    .toBe("working")
    .catch(() => {});
  // Never fail the tour on this — but never let a capture quietly claim a state
  // it did not reach either. A screenshot labelled "working" that is really
  // "idle" is worse than no screenshot.
  const reached = await panel.getAttribute("data-agent-state").catch(() => null);
  if (reached !== "working") {
    console.warn(
      `[tour] WARNING: agent settled on "${reached}", not "working" — the working/waiting captures are NOT trustworthy this run`
    );
  }
  return panelId;
}

let agentPanelId: string | null = null;

const SCENES: TourScene[] = [
  {
    id: "workbench",
    label: "Workbench",
    note: "The resting state. Does a pane read as a pane against the gutter, and is the loudest thing on screen something that has earned it?",
    run: async () => {},
  },
  {
    id: "fleet",
    label: "Fleet — many panes",
    note: "The case the theme was designed for. With this many panels, is anything competing for attention?",
    run: async (page) => {
      for (let i = 0; i < 4; i++) {
        await page
          .locator(SEL.toolbar.openTerminal)
          .click()
          .catch(() => {});
        await page.waitForTimeout(700);
      }
      await settle(page, 1400);
      // The note promises "with this many panels" — so the count is the claim.
      await requireSurface("fleet", async () => (await getGridPanelIds(page)).length >= 4);
    },
  },
  {
    id: "terminal",
    label: "Terminal + ANSI",
    note: "Seeded ANSI plus coloured git output. Are logs parseable without shouting, and is the dim slot (ANSI 90) actually readable?",
    run: async (page) => {
      await page
        .locator(SEL.toolbar.openTerminal)
        .click()
        .catch(() => {});
      await page
        .locator(SEL.panel.gridPanel)
        .first()
        .waitFor({ state: "visible", timeout: T_LONG })
        .catch(() => {});
      await settle(page, 1600);
      await page
        .locator(SEL.panel.gridPanel)
        .first()
        .click()
        .catch(() => {});
      await page.keyboard.type(SEEDED_ANSI_COMMAND);
      await page.keyboard.press("Enter");
      await settle(page, 1600);
      // The seeded output, not the keystrokes. A command that was typed into an
      // unfocused pane leaves a capture with no ANSI in it at all.
      await requireSurface("terminal", async () =>
        (await getTerminalText(page.locator(SEL.panel.gridPanel).first()).catch(() => "")).includes(
          SEEDED_ANSI_OUTPUT
        )
      );
    },
  },
  {
    id: "terminal-selection",
    label: "Terminal — selection",
    note: "Drag-select in the terminal. The fill is a fill, not a glyph: it has to be findable without reading as a highlight, and text over it must stay legible.",
    run: async (page) => {
      // Find the pane that already holds the seeded ANSI line rather than
      // assuming the first grid panel is it. An interactive reviewer can jump
      // straight here, and the grid re-flows as panes are added, so "first
      // panel" and "the terminal with content in it" are routinely different
      // panes — dragging across the wrong one produced an empty selection under
      // a note promising coloured glyphs.
      const findSeeded = async (): Promise<string | null> => {
        for (const id of await getGridPanelIds(page).catch(() => [] as string[])) {
          const text = await getTerminalText(page.locator(`[data-panel-id="${id}"]`)).catch(
            () => ""
          );
          if (text.includes(SEEDED_ANSI_OUTPUT)) return id;
        }
        return null;
      };

      let panelId = await findSeeded();
      if (!panelId) {
        const before = new Set(await getGridPanelIds(page).catch(() => [] as string[]));
        await page
          .locator(SEL.toolbar.openTerminal)
          .click()
          .catch(() => {});
        for (let i = 0; i < 40 && !panelId; i++) {
          const ids = await getGridPanelIds(page).catch(() => [] as string[]);
          panelId = ids.find((id) => !before.has(id)) ?? null;
          if (!panelId) await page.waitForTimeout(250);
        }
        if (panelId) {
          const fresh = page.locator(`[data-panel-id="${panelId}"]`);
          await settle(page, 1200);
          await fresh.click().catch(() => {});
          await page.keyboard.type(SEEDED_ANSI_COMMAND);
          await page.keyboard.press("Enter");
          await settle(page, 1600);
        }
      }

      if (!panelId) {
        await requireSurface("terminal-selection", async () => false);
        return;
      }

      const panel = page.locator(`[data-panel-id="${panelId}"]`);
      const box = await panel.boundingBox().catch(() => null);
      if (!box) {
        await requireSurface("terminal-selection", async () => false);
        return;
      }
      // Drag across the seeded ANSI line so the selection fill is judged under
      // coloured glyphs and not just prose.
      await page.mouse.move(box.x + 24, box.y + 96);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 80, box.y + 168, { steps: 24 });
      await page.mouse.up();
      await settle(page, 700);
      // The postcondition is xterm reporting a non-empty selection. A completed
      // mouse gesture proves only that the mouse moved.
      await requireSurface("terminal-selection", async () =>
        Boolean((await getTerminalSelection(panel).catch(() => "")).trim())
      );
    },
  },
  {
    id: "sidebar-hover",
    label: "Sidebar — hover",
    note: "Row hover. Perceptible, or did the field swallow it?",
    run: async (page) => {
      await page
        .locator('[data-worktree-branch="fix/retry-backoff-jitter"]')
        .first()
        .hover()
        .catch(() => {});
      await settle(page, 500);
    },
  },
  {
    id: "sidebar-search",
    label: "Sidebar — search",
    note: "Search highlight and match badges. Does the match read at a glance without borrowing the accent's job?",
    run: async (page) => {
      const search = page.locator(SEL.worktree.searchInput);
      await search.click().catch(() => {});
      await search.fill("retry").catch(() => {});
      await settle(page, 700);
      // The filtered result is the surface, not the text in the box: a query
      // that matched nothing still leaves the input reading "retry".
      await requireSurface("sidebar-search", () =>
        page.locator('[data-worktree-branch="fix/retry-backoff-jitter"]').first().isVisible()
      );
    },
  },
  {
    id: "context-menu",
    label: "Context menu",
    note: "Floating chrome. Whatever this theme separates with — shadow, hairline ring, material, or the ladder — does the menu sit above the surface behind it?",
    run: async (page) => {
      await page
        .locator(SEL.worktree.mainCard)
        .click({ button: "right" })
        .catch(() => {});
      await page
        .locator('[role="menu"]')
        .waitFor({ state: "visible", timeout: 4000 })
        .catch(() => {});
      await settle(page, 400);
      await requireSurface("context-menu", () => page.locator('[role="menu"]').first().isVisible());
    },
  },
  {
    id: "filter-popover",
    label: "Filter popover",
    note: "Segmented toggles on a near-black surface — can you tell which segment is active?",
    run: async (page) => {
      await page
        .locator(SEL.worktree.filterButton)
        .click()
        .catch(() => {});
      await page
        .locator(SEL.worktree.filterPopover)
        .waitFor({ state: "visible", timeout: 4000 })
        .catch(() => {});
      await settle(page, 400);
      await requireSurface("filter-popover", () =>
        page.locator(SEL.worktree.filterPopover).first().isVisible()
      );
    },
  },
  {
    id: "action-palette",
    label: "Action palette",
    note: "Selected row = raised fill + selection-outline, no accent. Is the selected row unambiguous?",
    run: async (page) => {
      const dialog = page.locator(SEL.actionPalette.dialog);
      // Double-Shift is the only route to THIS palette. The Cmd/Ctrl+K fallback
      // that used to sit here opens the separate Command Picker, which then
      // rendered on top of the action palette — so the capture showed two
      // stacked surfaces and the scene's note described neither of them.
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press("Shift");
        await page.keyboard.press("Shift");
        if (await dialog.isVisible({ timeout: 1500 }).catch(() => false)) break;
        await page.waitForTimeout(200);
      }
      await page
        .locator(SEL.actionPalette.searchInput)
        .fill("worktree")
        .catch(() => {});
      await settle(page, 700);
      await requireSurface(
        "action-palette",
        async () =>
          (await dialog.isVisible()) && !(await page.locator(SEL.commandPicker.dialog).isVisible())
      );
    },
  },
  {
    id: "project-switcher",
    label: "Project switcher",
    note: "An anchored popover. No scrim here, so its edge, its occlusion and its material are the whole separation story.",
    run: async (page) => {
      await page
        .locator(SEL.toolbar.projectSwitcherTrigger)
        .click()
        .catch(() => {});
      await settle(page, 700);
      await requireSurface("project-switcher", () =>
        page.locator(SEL.projectSwitcher.palette).first().isVisible()
      );
    },
  },
  {
    id: "notifications",
    label: "Notifications",
    note: "Inbox chrome and the status wash behind a row. The fixture raises warnings only, so judge the warning tier and the chrome — not the full four-colour status spread.",
    run: async (page) => {
      await page
        .locator(SEL.notifications.bellButton)
        .click()
        .catch(() => {});
      await settle(page, 700);
      // The inbox is a popover, not a dialog or menu: its list is the surface.
      await requireSurface("notifications", () =>
        page.locator('[role="list"][aria-label="Notifications"]').first().isVisible()
      );
    },
  },
  {
    id: "review-hub",
    label: "Review hub + diff",
    note: "The diff: insert and delete washes, word-level edits, gutters, and syntax over all of them. Do additions and deletions carry equal weight, and does syntax survive both washes?",
    run: async (page) => {
      await page
        .locator(SEL.worktree.mainCard)
        .hover()
        .catch(() => {});
      await settle(page, 300);
      const btn = page.locator(SEL.worktree.reviewHubButton).first();
      await btn.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
      await btn.click().catch(() => {});
      await page
        .locator(SEL.reviewHub.container)
        .waitFor({ state: "visible", timeout: 15_000 })
        .catch(() => {});
      await settle(page, 1200);
      // The file list starts collapsed behind "Show files (n)". Gate on the
      // toggle's own `aria-expanded` rather than on whether the diff button
      // happens to be visible yet — during the list's first paint the button is
      // absent while the list is already open, and clicking then COLLAPSES it.
      const toggle = page.locator(SEL.reviewHub.fileListToggle).first();
      if ((await toggle.getAttribute("aria-expanded").catch(() => null)) !== "true") {
        await toggle.click().catch(() => {});
        await settle(page, 600);
      }
      const diffBtn = page.locator(SEL.reviewHub.fileDiffButton("src/index.ts"));
      await diffBtn.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
      await diffBtn.click().catch(() => {});
      await settle(page, 1400);
      // The postcondition is the diff itself, not the button that opens it.
      await requireSurface("review-hub", () =>
        page.locator(SEL.reviewHub.diffMode).first().isVisible({ timeout: 4000 })
      );
    },
  },
  {
    id: "file-viewer",
    label: "File viewer — syntax",
    note: "Syntax roles on surface-canvas, not on the terminal — this is where the file viewer paints them. Comment and quote run a 3:1 soft floor; every other role owes AA.",
    run: async (page) => {
      // Scope to the toolbar: the sidebar's workspace-root row carries the same
      // accessible name, and `.first()` across the document picks whichever the
      // DOM happens to order first.
      await page
        .locator(`[role="toolbar"][aria-label="Main toolbar"] [aria-label="Browse files"]`)
        .first()
        .click()
        .catch(() => {});
      await page
        .locator('[role="tree"]')
        .first()
        .waitFor({ state: "visible", timeout: 10_000 })
        .catch(() => {});
      await settle(page, 800);
      await page
        .locator('[role="treeitem"][aria-label="src"]')
        .first()
        .click()
        .catch(() => {});
      await settle(page, 700);
      const file = page.locator('[role="treeitem"][aria-label="index.ts"]').first();
      await file.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
      await file.click().catch(() => {});
      await settle(page, 1600);
      // The postcondition is the viewer showing THIS file — a tree row that was
      // visible before the click proves nothing about what opened after it.
      await requireSurface("file-viewer", () =>
        page.locator('[role="treeitem"][aria-label="index.ts"][aria-current="true"]').isVisible()
      );
    },
  },
  {
    id: "settings",
    label: "Settings dialog",
    note: "Dialog over scrim. Cards must still lift off the dialog body with the ladder compressed.",
    run: async (page) => {
      const openSettings = page.locator(SEL.toolbar.openSettings);
      if (await openSettings.isVisible({ timeout: 2000 }).catch(() => false)) {
        await openSettings.click().catch(() => {});
      } else {
        await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
      }
      await page
        .locator(SEL.settings.heading)
        .waitFor({ state: "visible", timeout: 8000 })
        .catch(() => {});
      await settle(page, 1000);
      await requireSurface("settings", () =>
        page.locator(SEL.settings.heading).first().isVisible()
      );
    },
  },
  {
    id: "appearance",
    label: "Theme picker + hero",
    note: "The hero art next to the UI it produced. Do the artwork and the chrome read as the same place?",
    run: async (page) => {
      const openSettings = page.locator(SEL.toolbar.openSettings);
      if (await openSettings.isVisible({ timeout: 2000 }).catch(() => false)) {
        await openSettings.click().catch(() => {});
      } else {
        await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
      }
      await page
        .locator(SEL.settings.heading)
        .waitFor({ state: "visible", timeout: 8000 })
        .catch(() => {});
      const appearance = page.getByRole("tab", { name: "Appearance" }).first();
      await appearance.click().catch(() => {});
      await settle(page, 1400);
      // The hero art is the point of this scene, so an Appearance tab that
      // opened but rendered no theme card is still a failed capture.
      // `isVisible()` passes for an <img> that has laid out but not decoded, so
      // check the bitmap actually arrived.
      await requireSurface("appearance", () =>
        page
          .locator('img[src*="/themes/"]')
          .first()
          .evaluate((el) => el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0)
      );
    },
  },
  {
    id: "confirm",
    label: "Confirm dialog (danger)",
    note: "Destructive chrome. Is it unmistakably the most serious thing on screen, without outshouting a waiting agent?",
    run: async (page) => {
      await page
        .locator('[data-worktree-branch="chore/bump-electron-42"]')
        .first()
        .click({ button: "right" })
        .catch(() => {});
      await page
        .locator('[role="menu"]')
        .waitFor({ state: "visible", timeout: 4000 })
        .catch(() => {});
      const del = page.getByRole("menuitem", { name: /delete/i }).first();
      await del.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
      await del.click().catch(() => {});
      const confirmDialog = page
        .locator('[role="alertdialog"], [role="dialog"]')
        .filter({ hasText: /delete/i })
        .last();
      await confirmDialog.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      await settle(page, 500);
      await requireSurface("confirm", () => confirmDialog.isVisible());
    },
  },
  {
    id: "agent-working",
    label: "Agent — working",
    note: "A live agent mid-task. `activity.working` should read as ambient — present, but not a summons. Compare it against the waiting scene.",
    run: async (page) => {
      agentPanelId = await launchWorkingAgent(page);
      await settle(page, 1200);
    },
  },
  {
    id: "agent-waiting",
    label: "Agent — WAITING",
    note: "The loudest state the theme can produce. Across the pane, its chip and the dock — is a waiting agent unmissable at a glance, and is it clearly louder than working?",
    run: async (page) => {
      if (!agentPanelId) agentPanelId = await launchWorkingAgent(page);
      if (!agentPanelId) return;
      // Stop the OSC heartbeat; the idle debounce settles the FSM to waiting.
      const wrote = await ptyWrite(page, agentPanelId, `${FAKE_AGENT_IDLE}\r`);
      if (!wrote) {
        console.warn(
          "[tour] WARNING: terminal.write unavailable — cannot drive the agent to waiting"
        );
        return;
      }
      const panel = page.locator(`[data-panel-id="${agentPanelId}"]`);
      await expect
        .poll(() => panel.getAttribute("data-agent-state"), {
          timeout: T_LONG * 2,
          intervals: [500, 1000],
        })
        .toBe("waiting")
        .catch(() => {});
      const reached = await panel.getAttribute("data-agent-state").catch(() => null);
      if (reached !== "waiting") {
        console.warn(
          `[tour] WARNING: agent settled on "${reached}", not "waiting" — this capture does NOT show the state it claims`
        );
      }
      await settle(page, 1200);
    },
  },
  {
    id: "dock",
    label: "Dock",
    note: "Minimised panes. Does the dock separate from the grid above it, and do the chips carry their panes' states?",
    run: async (page) => {
      await page
        .locator(SEL.toolbar.openTerminal)
        .click()
        .catch(() => {});
      await settle(page, 1600);
      const minimize = page.locator(SEL.panel.minimize).first();
      await minimize.waitFor({ state: "visible", timeout: 2500 }).catch(() => {});
      await minimize.click().catch(() => {});
      await settle(page, 1000);
      // The postcondition is a chip in the dock, not a click on minimize.
      await requireSurface("dock", async () => (await getDockChipIds(page)).length > 0);
    },
  },
];

test("theme tour — interactive", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_TOUR=1 is required for the interactive tour",
  });
  test.skip(!ENABLED, "Set DAINTREE_TOUR=1 to run the interactive theme tour");
  // Fail on a typo'd id here rather than 90 seconds into a launch, and say what
  // the valid ones are — this harness is meant to be pointed at any theme.
  const known = BUILT_IN_APP_SCHEMES.map((s) => s.id);
  for (const [label, id] of [
    ["DAINTREE_TOUR_THEME", THEME],
    ["DAINTREE_TOUR_COMPARE", COMPARE],
  ] as const) {
    if (!known.includes(id)) {
      throw new Error(`${label}="${id}" is not a built-in theme. Available: ${known.join(", ")}`);
    }
  }
  // The window stays open for as long as the reviewer wants it.
  test.setTimeout(0);

  const repo = createTourRepo();
  // Prefix deliberately excludes "daintree-e2e": launchApp's pre-launch hygiene
  // pkills that pattern, and a long-lived tour would be SIGKILLed by any other
  // e2e run started on the same machine while the reviewer is still looking.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-themetour-"));
  let ctx: AppContext | undefined;

  try {
    // The fake `claude` has to be on PATH before launch — the agent-state scenes
    // need a real FSM transition, not a faked class name.
    const fakeBinDir = installFakeAgent(repo.dir);
    ctx = await launchApp({
      userDataDir,
      windowSize: { width: 1680, height: 1050 },
      env: fakeAgentEnv(fakeBinDir),
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await page.evaluate(async () => {
      const cur = await window.electron.project.getCurrent();
      if (cur?.id)
        await window.electron.project.update(cur.id, { emoji: "🕳️", name: "Helios Dashboard" });
    });

    // Registered before the theme switch so the reload that applies the theme
    // is also what first paints the HUD.
    await page.addInitScript(installTourHud);

    let activeTheme = THEME;
    let sceneIndex = 0;

    const pushState = async (status: string, busy: boolean) => {
      const state: TourState = {
        themeId: THEME,
        compareId: COMPARE,
        activeThemeId: activeTheme,
        sceneIndex,
        scenes: SCENES.map(({ id, label, note }) => ({ id, label, note })),
        status,
        busy,
      };
      await page
        .evaluate((s) => {
          window.__tourState = s;
          window.__tourSetState?.(s);
        }, state)
        .catch(() => {});
    };

    const applyTheme = async (id: string) => {
      await setAppTheme(page, id);
      await dismissBlockingPalette(page).catch(() => {});
      await page
        .locator(SEL.worktree.mainCard)
        .waitFor({ state: "visible", timeout: T_LONG })
        .catch(() => {});
      await settle(page, 800);
    };

    const shoot = async (scene: TourScene, index: number) => {
      mkdirSync(SHOT_DIR, { recursive: true });
      const file = path.join(SHOT_DIR, `${String(index + 1).padStart(2, "0")}-${scene.id}.png`);
      // Hide the HUD so the capture is the app, not the instrument.
      await page
        .evaluate(() => {
          const el = document.getElementById("daintree-theme-tour");
          if (el) el.style.visibility = "hidden";
        })
        .catch(() => {});
      await page
        .screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" })
        .catch(() => {});
      await page
        .evaluate(() => {
          const el = document.getElementById("daintree-theme-tour");
          if (el) el.style.visibility = "";
        })
        .catch(() => {});
      console.log(`[tour] captured ${path.relative(process.cwd(), file)}`);
    };

    const runScene = async (index: number, capture = false) => {
      sceneIndex = index;
      const scene = SCENES[index]!;
      await pushState(`entering ${scene.label}…`, true);
      await reset(page);
      try {
        await scene.run(page);
      } catch (error) {
        console.warn(`[tour] scene "${scene.id}" failed:`, String(error).slice(0, 200));
      }
      await pushState("ready", false);
      if (capture) await shoot(scene, index);
    };

    await applyTheme(activeTheme);

    if (AUTO) {
      // Unattended: walk every scene, capture each, exit. The agent scenes are
      // ordered so `working` runs before `waiting` and can hand off its panel.
      for (let i = 0; i < SCENES.length; i++) await runScene(i, true);
      console.log(`\n[tour] captured ${SCENES.length} scenes to ${SHOT_DIR}\n`);
      return;
    }

    await runScene(0);

    console.log(
      `\n[tour] ${activeTheme} is live. Use the panel in the bottom-right of the app window.\n` +
        `[tour] Press "finish" there when you're done — the window stays open until you do.\n`
    );

    // Reviewer-driven loop. Poll rather than waitForFunction so a reload
    // mid-wait (the compare toggle) can't reject the whole run.
    for (;;) {
      if (page.isClosed()) break;
      const cmd = await page
        .evaluate(() => {
          const c = window.__tourCmd;
          window.__tourCmd = null;
          return c;
        })
        .catch(() => null);

      if (!cmd) {
        await page.waitForTimeout(200);
        continue;
      }
      if (cmd.kind === "finish") break;

      if (cmd.kind === "compare") {
        activeTheme = activeTheme === THEME ? COMPARE : THEME;
        await pushState(`switching to ${activeTheme}…`, true);
        await applyTheme(activeTheme);
        await runScene(sceneIndex);
        continue;
      }

      const next =
        cmd.kind === "goto"
          ? cmd.index
          : cmd.kind === "next"
            ? (sceneIndex + 1) % SCENES.length
            : (sceneIndex - 1 + SCENES.length) % SCENES.length;
      if (next >= 0 && next < SCENES.length) await runScene(next);
    }
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
