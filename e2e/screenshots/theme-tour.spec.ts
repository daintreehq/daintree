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
import { getTerminalText, waitForTerminalText, writeTerminalInput } from "../helpers/terminal";
import { getGridPanelIds } from "../helpers/panels";
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

interface TourScene extends TourSceneMeta {
  run: (page: Page) => Promise<void>;
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
    note: "The resting state. Does a pane read as a pane against the gutter, with the ladder this flat?",
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
    },
  },
  {
    id: "terminal",
    label: "Terminal + ANSI",
    note: "ANSI held near 45% saturation. Are logs and diffs still parseable without shouting?",
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
      await page.keyboard.type(
        "printf '\\e[31mred \\e[32mgreen \\e[33myellow \\e[34mblue \\e[35mmagenta \\e[36mcyan \\e[90mdim\\e[0m\\n'; git log --oneline --color=always | head -4; git status --short"
      );
      await page.keyboard.press("Enter");
      await settle(page, 1600);
    },
  },
  {
    id: "sidebar-hover",
    label: "Sidebar — hover",
    note: "Hover is 3.5% white on near-black. Perceptible, or did the field swallow it?",
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
    note: "Search runs on the cool water lane, not the bone accent — the accent is too neutral to highlight with.",
    run: async (page) => {
      const search = page.locator(SEL.worktree.searchInput);
      await search.click().catch(() => {});
      await search.fill("retry").catch(() => {});
      await settle(page, 700);
    },
  },
  {
    id: "context-menu",
    label: "Context menu",
    note: "Floating chrome. Shadows are off, so the only edge is a hairline ring plus the frosted material.",
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
    },
  },
  {
    id: "action-palette",
    label: "Action palette",
    note: "Selected row = raised fill + selection-outline, no accent. Is the selected row unambiguous?",
    run: async (page) => {
      await page.keyboard.press("Shift");
      await page.keyboard.press("Shift");
      const dialog = page.locator(SEL.actionPalette.dialog);
      if (!(await dialog.isVisible({ timeout: 2000 }).catch(() => false))) {
        await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
      }
      await dialog.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      await page
        .locator(SEL.actionPalette.searchInput)
        .fill("worktree")
        .catch(() => {});
      await settle(page, 700);
    },
  },
  {
    id: "project-switcher",
    label: "Project switcher",
    note: "An anchored popover — no scrim here, so its ring, its occlusion and the 14px material are the whole separation story.",
    run: async (page) => {
      await page
        .locator(SEL.toolbar.projectSwitcherTrigger)
        .click()
        .catch(() => {});
      await settle(page, 700);
    },
  },
  {
    id: "notifications",
    label: "Notifications",
    note: "Inbox chrome and any status washes — statusSurfaceOpacity is dialled to 0.75 here.",
    run: async (page) => {
      await page
        .locator(SEL.notifications.bellButton)
        .click()
        .catch(() => {});
      await settle(page, 700);
    },
  },
  {
    id: "review-hub",
    label: "Review hub + diff",
    note: "Diff washes and syntax on the canvas. Insert/delete tints on a field this dark are the risk.",
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
      const diffBtn = page.locator(SEL.reviewHub.fileDiffButton("src/index.ts"));
      if (await diffBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
        await diffBtn.click().catch(() => {});
        await settle(page, 1200);
      }
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
    },
  },
  {
    id: "appearance",
    label: "Theme picker + hero",
    note: "The hero art next to the UI it produced. Do the cave and the chrome read as the same place?",
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
    },
  },
  {
    id: "confirm",
    label: "Confirm dialog (danger)",
    note: "The second loud thing. Destructive chrome should be the brightest surface on screen after waiting.",
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
      await page
        .locator('[role="alertdialog"], [role="dialog"]')
        .filter({ hasText: /delete/i })
        .last()
        .waitFor({ state: "visible", timeout: 5000 })
        .catch(() => {});
      await settle(page, 500);
    },
  },
  {
    id: "agent-working",
    label: "Agent — working",
    note: "A live agent mid-task. `activity.working` is a QUIET colour here (4.45:1) — it should read as ambient, not as a summons.",
    run: async (page) => {
      agentPanelId = await launchWorkingAgent(page);
      await settle(page, 1200);
    },
  },
  {
    id: "agent-waiting",
    label: "Agent — WAITING",
    note: "The whole theme. `activity.waiting` at 13.09:1 is the brightest thing the palette can produce — across the pane, its chip and the dock, is it unmissable?",
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
    note: "Minimised panes. Dock sits on the sidebar tone with a 12% limestone hairline above it.",
    run: async (page) => {
      await page
        .locator(SEL.toolbar.openTerminal)
        .click()
        .catch(() => {});
      await settle(page, 1600);
      const minimize = page.locator(SEL.panel.minimize).first();
      if (await minimize.isVisible({ timeout: 2500 }).catch(() => false)) {
        await minimize.click().catch(() => {});
        await settle(page, 1000);
      }
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
