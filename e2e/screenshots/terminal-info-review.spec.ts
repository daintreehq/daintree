/**
 * `TerminalInfoDialog` visual-review harness (#11978).
 *
 * A forty-row properties sheet is judged on rendered pixels. Half of what is wrong
 * with one — a value column nothing shares a left edge with, a path that eats its own
 * filename, a section header that reads at the same weight as the rows under it, a
 * tooltip that fires on a value already fully visible — is invisible in the JSX and
 * unmissable in a PNG.
 *
 * Every state here is driven through the REAL seams, never a renderer mock:
 *
 *   - terminals are created by dispatching `terminal.new` and `agent.launch`, so the
 *     panel-store half of the dialog (spawnedBy, location, spawnStatus, launch flags)
 *     is whatever the app actually stamped.
 *   - the agent states come from `e2e/helpers/fakeAgent`, a real CLI on a real PTY
 *     emitting real OSC 9;4 progress, so `AgentStateService` runs its genuine FSM.
 *   - the exited states are reached by letting the process EXIT, not by killing the
 *     panel: `terminal.kill` removes the panel outright, which is the one thing that
 *     cannot show what an exited terminal's info dialog looks like. An agent exiting
 *     0 and a plain shell exiting non-zero are both preserved by
 *     `src/store/listeners/panel/lifecycle.ts`, which is exactly the state we want.
 *   - loading and load-failure come from the main-process fault registry
 *     (`DAINTREE_E2E_FAULT_MODE=1` + `e2e/helpers/ipcFaults`) on `terminal:get-info`,
 *     so the dialog takes its genuine slow path and its genuine error path.
 *
 *   DAINTREE_SHOT_TERMINFO=1 npx playwright test --project=screenshots terminal-info-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_TERMINFO  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME     optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG       optional suffix so rounds sit side by side
 *   DAINTREE_SHOT_ONLY      comma-separated step filter (see step names below)
 *   DAINTREE_SHOT_OUT       optional absolute output dir (default artifacts/terminal-info-shots)
 *
 * Output: <out>/<NN-slug>[-tag].png (artifacts/ is gitignored).
 */

import { test, type Page, type ElectronApplication } from "@playwright/test";
import { execFileSync } from "child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { injectDelay, injectFault, clearAllFaults } from "../helpers/ipcFaults";
import {
  installFakeAgent,
  fakeAgentEnv,
  ptyWrite,
  FAKE_AGENT_STOP,
  FAKE_AGENT_READY,
} from "../helpers/fakeAgent";
import { getTerminalTextById } from "../helpers/terminal";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";
import { BUILT_IN_THEME_SOURCES } from "@shared/theme/builtInThemeSources";

const ENABLED = !!process.env.DAINTREE_SHOT_TERMINFO;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR =
  process.env.DAINTREE_SHOT_OUT ?? path.resolve(process.cwd(), "artifacts", "terminal-info-shots");

/**
 * The dialog CARD, not the surface element.
 *
 * `AppDialog` puts `role="dialog"` on the `fixed inset-0` scrim, so screenshotting the
 * role selector silently returns the whole window — a full-window PNG that looks like a
 * successful crop until you compare its dimensions.
 */
const DIALOG = "[data-app-dialog-surface] > div";

/**
 * The stable hooks this harness asserts against before it will write a file. The
 * redesign may move, restyle, or re-shape any of these — it must not delete them, or
 * the harness stops being able to prove the state it captured is the state it meant to.
 *
 * Deliberately mixed: `body`/`loading`/`error` are testids the dialog owns, while the
 * per-state markers are the rendered TEXT of a value only that state produces. Text
 * markers survive a restyle and fail loudly on a relabel, which is the correct
 * sensitivity for a design harness — a renamed label is a thing the review should see.
 */
const TID = {
  body: '[data-testid="terminal-info-body"]',
  pending: '[data-testid="terminal-info-pending"]',
  error: '[data-testid="terminal-info-error"]',
  copy: '[data-testid="terminal-info-copy"]',
} as const;

/** The IPC channel behind `window.electron.terminal.getInfo` (electron/ipc/channels.ts). */
const CH_GET_INFO = "terminal:get-info";

const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
  /*
   * Skeleton bones start at opacity 0 and are faded in by the pulse keyframes after
   * the 400ms Doherty delay, so the animation freeze above leaves them INVISIBLE — a
   * loading shot that looks like an empty panel and sends the whole review off
   * reviewing a screen that does not exist. Pin them visible.
   */
  [class*="animate-pulse-"] { opacity: 1 !important; }
`;

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/**
 * The repo is named at absurd length on purpose.
 *
 * `cwd` is the dialog's longest guaranteed value and the one most likely to be
 * mistreated — a short `/tmp/x` fixture makes every alignment and truncation decision
 * on this surface look correct. The nesting also gives the middle-vs-end truncation
 * question a real subject: the leaf directory is the informative half of a path, and a
 * plain `text-overflow: ellipsis` throws it away.
 */
function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "daintree-terminfo-shots-"));
  const dir = path.join(
    root,
    "acme-platform",
    "services",
    "telemetry-ingest-worker-eu-west-1-canary"
  );
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(dir, { recursive: true });
  mkdirSync(wtRoot, { recursive: true });

  git(["init", "-b", "main", dir], root);
  git(["config", "user.email", "dev@daintree.dev"], dir);
  git(["config", "user.name", "Daintree Test"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  writeFileSync(path.join(dir, "README.md"), "# Telemetry ingest worker\n");
  git(["add", "-A"], dir);
  git(["commit", "-m", "initial commit"], dir);

  return {
    dir,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/** Dispatch a real action through the E2E hook and return its result. */
async function dispatch(page: Page, id: string, args?: unknown): Promise<unknown> {
  return page.evaluate(
    async ([actionId, actionArgs]) => {
      const run = (
        window as unknown as {
          __daintreeDispatchAction?: (
            id: string,
            args: unknown,
            opts: unknown
          ) => Promise<{ ok: boolean; result?: unknown; error?: { message: string } }>;
        }
      ).__daintreeDispatchAction;
      if (typeof run !== "function") throw new Error("Action dispatch hook not available");
      const outcome = await run(actionId as string, actionArgs, { source: "test" });
      if (!outcome?.ok) throw new Error(outcome?.error?.message ?? "dispatch failed");
      return outcome.result ?? null;
    },
    [id, args] as [string, unknown]
  );
}

/** Create a plain shell terminal and return its panel id. */
async function newTerminal(page: Page, spawnedBy?: string): Promise<string> {
  const result = (await dispatch(page, "terminal.new", spawnedBy ? { spawnedBy } : undefined)) as {
    terminalId?: string;
  } | null;
  const id = result?.terminalId;
  if (!id)
    throw new Error(`terminal.new returned no terminalId (spawnedBy=${spawnedBy ?? "none"})`);
  return id;
}

/** Launch the fake agent and return its panel id. */
async function newAgent(page: Page, options: Record<string, unknown> = {}): Promise<string> {
  const result = (await dispatch(page, "agent.launch", {
    agentId: "claude",
    location: "grid",
    force: true,
    ...options,
  })) as { terminalId?: string | null } | null;
  const id = result?.terminalId;
  if (!id) throw new Error(`agent.launch returned no terminalId (${JSON.stringify(options)})`);
  return id;
}

/**
 * Walk the fake agent through its trust prompt so it starts emitting OSC 9;4 progress.
 * Until this lands the FSM has nothing to read and `agentState` stays unset — which is
 * a real state, but not the populated one this harness is trying to show.
 */
async function trustAgent(page: Page, terminalId: string): Promise<void> {
  const deadline = Date.now() + 25_000;
  let answered = false;
  while (Date.now() < deadline) {
    const text = (await getTerminalTextById(page, terminalId).catch(() => "")).toLowerCase();
    if (text.includes(FAKE_AGENT_READY.toLowerCase())) return;
    if (!answered && (text.includes("enter to confirm") || text.includes("trust this folder"))) {
      await ptyWrite(page, terminalId, "\r");
      answered = true;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`[terminfo-shots] agent ${terminalId} never reached ${FAKE_AGENT_READY}`);
}

/**
 * Wait until a plain shell has actually painted something before writing to it. A
 * `exit 3` sent into a PTY that has not finished spawning is swallowed, and the panel
 * then sits alive through the whole run with no exit code — a state the harness would
 * screenshot and label "exited".
 */
async function waitForShellPrompt(page: Page, terminalId: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const text = await getTerminalTextById(page, terminalId).catch(() => "");
    if (text.trim().length > 0) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`[terminfo-shots] shell ${terminalId} never produced output`);
}

/**
 * Wait until a panel's process has actually gone.
 *
 * A fixed `waitForTimeout` after writing a stop token proves nothing: if the write is
 * swallowed the panel simply stays alive and the step goes on to screenshot a running
 * terminal under the name "exited" — which is precisely what round 2 shipped. There is
 * no `data-runtime-status` attribute to poll, so this reads the two signals that do
 * exist: the marker the dying process prints, and the exit banner the panel renders.
 */
async function waitForExited(page: Page, terminalId: string, marker: string): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const text = await getTerminalTextById(page, terminalId).catch(() => "");
    if (text.includes(marker)) return;
    const banner = await page
      .locator(
        `[data-panel-id="${terminalId}"] [role="alert"], [data-panel-id="${terminalId}"] [role="status"]`
      )
      .allTextContents()
      .catch(() => [] as string[]);
    if (banner.some((entry) => /exit/i.test(entry))) return;
    await page.waitForTimeout(250);
  }
  throw new Error(
    `[terminfo-shots] ${terminalId} never showed "${marker}" or an exit banner — its process did not die, so any shot of it would be mislabelled`
  );
}

/** Open the info dialog for one panel by dispatching the real action. */
async function openInfo(page: Page, terminalId: string): Promise<void> {
  await dispatch(page, "terminal.info.open", { terminalId });
}

async function closeDialog(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if (
      !(await page
        .locator(DIALOG)
        .first()
        .isVisible()
        .catch(() => false))
    )
      return;
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 200);
  }
}

/**
 * Screenshot, but only after the state it claims to be has been proven on screen.
 *
 * This is the hard rule of the whole harness: a capture run that quietly writes a
 * plausible-looking wrong artifact is worse than one that fails, because the review
 * then reasons about a screen that never existed.
 */
async function snap(
  page: Page,
  slug: string,
  opts: { marker: string; text?: string; locator?: string; markerTimeout?: number }
): Promise<void> {
  await page
    .locator(opts.marker)
    .first()
    .waitFor({ state: "visible", timeout: opts.markerTimeout ?? 10_000 });
  if (opts.text) {
    await page
      .locator(DIALOG)
      .getByText(opts.text, { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: opts.markerTimeout ?? 10_000 });
  }
  await settle(page);
  // Re-checked AFTER the settle, not only before it: the app's own later render can
  // replace the state between the assertion and the shutter.
  if (!(await page.locator(opts.marker).first().isVisible())) {
    throw new Error(`[terminfo-shots] "${slug}": marker ${opts.marker} vanished before the shot`);
  }
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  if (opts.locator) {
    await page.locator(opts.locator).last().screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }
}

/**
 * Capture a surface that can legitimately land in more than one state, and record which.
 *
 * Same hard rule as `snap` — nothing is written until a state is proven on screen — but
 * the caller names the states it will accept instead of the one it expects. The reached
 * state is appended to the filename, so the artifact carries its own label and a review
 * can never mistake an error shot for a populated one.
 */
async function snapEither(
  page: Page,
  slug: string,
  opts: { locator?: string } & Record<string, string>
): Promise<string> {
  const { locator, ...states } = opts;
  const deadline = Date.now() + 15_000;
  let reached: string | null = null;
  while (Date.now() < deadline && !reached) {
    for (const [name, selector] of Object.entries(states)) {
      if (
        await page
          .locator(selector)
          .first()
          .isVisible()
          .catch(() => false)
      ) {
        reached = name;
        break;
      }
    }
    if (!reached) await page.waitForTimeout(250);
  }
  if (!reached) {
    const text = await page
      .locator(DIALOG)
      .innerText()
      .catch(() => "<dialog not rendered>");
    throw new Error(
      `[terminfo-shots] "${slug}": none of [${Object.keys(states).join(", ")}] appeared. ` +
        `Dialog read: ${text.slice(0, 300).replace(/\s+/g, " ")}`
    );
  }
  await snap(page, `${slug}-${reached}`, { marker: states[reached]!, locator });
  return reached;
}

/**
 * Every built-in theme. Switching themes in place reloads the renderer (see
 * `setAppTheme`), which destroys every terminal this harness spent a minute spawning,
 * so a cross-theme sweep boots once per theme:
 *
 *   for t in <these ids>; do
 *     DAINTREE_SHOT_TERMINFO=1 DAINTREE_SHOT_THEME=$t DAINTREE_SHOT_TAG=$t \
 *     DAINTREE_SHOT_ONLY=agent-full npx playwright test --project=screenshots terminal-info-review
 *   done
 */
export const ALL_THEMES = BUILT_IN_THEME_SOURCES.map((theme) => theme.id);

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

// A failed step must not abort the run — the remaining shots are still worth having,
// and a per-theme sweep should not lose fourteen themes to one bad selector. But the
// run must still FAIL: a silent exit 0 over an empty output directory reads as success.
const failures: string[] = [];

test("terminal info review — diagnostic states", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_TERMINFO is required for the terminal-info capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_TERMINFO to run the terminal-info capture");

  failures.length = 0;
  // Stamped before anything is captured so the tally at the end can tell this run's
  // artifacts from the previous run's. 1s of slack absorbs filesystem mtime coarseness.
  const runStartedAt = Date.now() - 1000;
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const binDir = installFakeAgent(repo.dir);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-terminfoshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      env: { ...fakeAgentEnv(binDir), DAINTREE_E2E_FAULT_MODE: "1" },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const app: ElectronApplication = ctx.app;
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Telemetry Ingest");
    // Before any terminal is spawned: setAppTheme reloads the renderer.
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await page
      .locator(SEL.worktree.mainCard)
      .waitFor({ state: "visible", timeout: T_LONG })
      .catch(() => {});
    await settle(page, 1500);
    await dismissBlockingPalette(page);

    /**
     * Every terminal this run inspects, spawned up front.
     *
     * Up front rather than per-step because each one is a real PTY on a real fixture
     * repo: spawning them lazily inside a step means a step that fails leaves the next
     * one inspecting a panel that does not exist, and the failure reads as a dialog bug.
     */
    const ids: Record<string, string> = {};

    // The headline state. Long flags and a long model id on purpose — the launch-context
    // rows are where argv chips have to wrap, and a two-flag fixture proves nothing.
    ids.agentFull = await newAgent(page, {
      name: "Claude: ingest backfill",
      model: "claude-opus-4-6-20260115-preview",
      agentLaunchFlags: [
        "--dangerously-skip-permissions",
        "--add-dir=/Users/dev/acme-platform/services/telemetry-ingest-worker-eu-west-1-canary",
        "--mcp-config=.daintree/mcp.json",
        "--verbose",
      ],
    });
    await trustAgent(page, ids.agentFull);

    // Sparse: a plain shell, nothing detected, most optional rows absent.
    ids.plain = await newTerminal(page);

    // Provenance rows (#11808): MCP transport, and the assistant on the other end of it.
    ids.mcp = await newTerminal(page, "mcp");
    ids.assistant = await newTerminal(page, "assistant");

    // Exited agent: the process leaves with 0, which lifecycle.ts preserves. Gives
    // `everDetectedAgent` with no `detectedAgentId` — the "None — agent has exited" row.
    ids.exitedAgent = await newAgent(page, { name: "Claude: schema migration" });
    await trustAgent(page, ids.exitedAgent);
    // The trailing CR is load-bearing. The PTY slave is in canonical mode, so the line
    // discipline buffers input until a line terminator arrives — without it the fake
    // agent's stdin handler never fires, the process never exits, and this step
    // screenshots a RUNNING agent while calling it exited. That is exactly what round 2
    // captured, and it is the same trap `waitForShellPrompt` above already warns about.
    await ptyWrite(page, ids.exitedAgent, FAKE_AGENT_STOP + "\r");
    await waitForExited(page, ids.exitedAgent, "FAKE_CLAUDE_EXIT");

    // Exited plain shell: a non-zero code is always preserved, and it is the only way
    // to see the Exit Code row on a terminal that never ran an agent.
    ids.exitedPlain = await newTerminal(page);
    await waitForShellPrompt(page, ids.exitedPlain);
    await ptyWrite(page, ids.exitedPlain, "exit 3\r");
    await waitForExited(page, ids.exitedPlain, "__never__");

    await dismissBlockingPalette(page);
    await settle(page, 800);

    /**
     * Runs one state, then unconditionally returns to rest. Unconditionally, not on the
     * success path only: a step that dies holding the dialog open would otherwise wedge
     * every step after it behind a modal.
     */
    const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
      if (ONLY.length > 0 && !ONLY.includes(name)) return;
      try {
        await fn();
      } catch (error) {
        const detail = String(error).slice(0, 300);
        console.warn(`[terminfo-shots] step "${name}" failed:`, detail);
        failures.push(`${name}: ${detail}`);
      } finally {
        await clearAllFaults(app).catch(() => {});
        await closeDialog(page).catch((error) => {
          failures.push(`${name} (reset): ${String(error).slice(0, 200)}`);
        });
        await page.emulateMedia({ forcedColors: null, contrast: null }).catch(() => {});
      }
    };

    // 1. The headline: a live agent, every section populated, long values throughout.
    await step("agent-full", async () => {
      await openInfo(page, ids.agentFull);
      await snap(page, "10-agent-full", { marker: TID.body, locator: DIALOG });
      await snap(page, "11-agent-full-in-window", { marker: TID.body });
    });

    // 2. The tail of the same dialog. Half the sections live below the fold and nobody
    //    has looked at them; scrolling there is the only way the review sees them.
    await step("agent-full-tail", async () => {
      await openInfo(page, ids.agentFull);
      await page.locator(TID.body).first().waitFor({ state: "visible", timeout: 10_000 });
      // ScrollShadow renders the scroll box as `flex-1 overflow-y-auto` inside the card
      // (src/components/ui/ScrollShadow.tsx:59) — AppDialog.Body's own element.
      const scrolled = await page.evaluate(() => {
        const scroller = document
          .querySelector("[data-app-dialog-surface]")
          ?.querySelector<HTMLElement>(".overflow-y-auto");
        if (!scroller) return false;
        scroller.scrollTop = scroller.scrollHeight;
        return scroller.scrollTop > 0;
      });
      if (!scrolled) {
        throw new Error("dialog body did not scroll — nothing below the fold to capture");
      }
      await snap(page, "12-agent-full-tail", { marker: TID.body, locator: DIALOG });
    });

    // 3. Sparse plain shell — where the unavailable-value treatment is the whole design.
    await step("plain-sparse", async () => {
      await openInfo(page, ids.plain);
      await snap(page, "20-plain-sparse", { marker: TID.body, locator: DIALOG });
    });

    // 4/5. Provenance: transport vs actor, deliberately two rows (#11808).
    await step("mcp", async () => {
      await openInfo(page, ids.mcp);
      await snap(page, "25-spawned-mcp", { marker: TID.body, locator: DIALOG });
    });

    await step("assistant", async () => {
      await openInfo(page, ids.assistant);
      await snap(page, "26-spawned-assistant", { marker: TID.body, locator: DIALOG });
    });

    // 6. Agent that has exited — the sticky-detection state the live view cannot show.
    await step("exited-agent", async () => {
      await openInfo(page, ids.exitedAgent);
      await snap(page, "30-exited-agent", { marker: TID.body, locator: DIALOG });
    });

    // 7. Plain shell that exited non-zero — the only route to the Exit Code row.
    //
    // Captured through `snapEither` rather than `snap`, because which state this
    // reaches is itself the question. `handleTerminalGetInfo` resolves through
    // `ptyClient.getTerminalInfo`, which has nothing to return once the PTY record is
    // gone, so a panel Daintree deliberately PRESERVES for debugging can answer its own
    // info request with "Terminal <id> not found". Asserting the body here would fail
    // the step and hide that; asserting the error would bless it. Prove whichever it is
    // and name the file for it.
    await step("exited-plain", async () => {
      await openInfo(page, ids.exitedPlain);
      const reached = await snapEither(page, "31-exited-plain", {
        body: TID.body,
        error: TID.error,
        locator: DIALOG,
      });
      console.log(`[terminfo-shots] exited-plain reached the "${reached}" state`);
    });

    // 8. Load failure through the real error path, on the real channel.
    await step("error", async () => {
      await injectFault(app, CH_GET_INFO, "EPIPE: the pty host is not responding");
      await openInfo(page, ids.agentFull);
      await snap(page, "40-load-error", { marker: TID.error, locator: DIALOG });
    });

    // 9. Loading held open by a main-process delay, so the shot is the real in-flight
    //    render rather than a paused animation frame. Past the 400ms Doherty gate.
    //
    //    The marker is a pending CELL, not a loading screen: the dialog no longer has an
    //    all-or-nothing loading branch. Everything the panel store owns paints on the
    //    first frame and only the rows waiting on the host carry a skeleton, so the shot
    //    has to prove the shell AND a bone are on screen together — which is the whole
    //    claim being made about this state.
    await step("loading", async () => {
      await injectDelay(app, CH_GET_INFO, 9000);
      await openInfo(page, ids.agentFull);
      await page.waitForTimeout(1200);
      await page.locator(TID.body).first().waitFor({ state: "visible", timeout: 10_000 });
      await snap(page, "50-loading", { marker: TID.pending, locator: DIALOG });
    });

    // 10. Keyboard focus on the copy action — the only affordance on the surface, and
    //     one reached by Tab on a dialog opened from the command palette.
    await step("focus", async () => {
      await openInfo(page, ids.agentFull);
      await page.locator(TID.body).first().waitFor({ state: "visible", timeout: 10_000 });
      await page.locator(TID.copy).first().focus();
      await snap(page, "60-focus-copy", { marker: TID.copy, locator: DIALOG });
    });

    // 11. prefers-contrast: more — macOS "Increase contrast".
    await step("contrast", async () => {
      await page.emulateMedia({ contrast: "more" });
      await openInfo(page, ids.agentFull);
      await snap(page, "70-contrast-more", { marker: TID.body, locator: DIALOG });
    });

    // 12. forced-colors: active — Windows high contrast swaps in system colours, and
    //     anything carrying meaning in a tint alone collapses here.
    await step("forced", async () => {
      await page.emulateMedia({ forcedColors: "active" });
      await openInfo(page, ids.agentFull);
      await snap(page, "75-forced-colors", { marker: TID.body, locator: DIALOG });
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

  // Counted here rather than trusted from the exit code: swallowed per-step errors are
  // exactly how a harness reports PASS over an empty directory.
  //
  // Counted by MTIME, not by existence. A plain file count is satisfied by last run's
  // PNGs still sitting in the output directory, so a run that launched, failed every
  // step and wrote nothing would report the previous run's total and read as a pass —
  // the same class of lie as trusting the exit code, one level further in.
  const written = existsSync(OUTPUT_DIR)
    ? readdirSync(OUTPUT_DIR).filter(
        (f) =>
          f.endsWith(`${TAG}.png`) && statSync(path.join(OUTPUT_DIR, f)).mtimeMs >= runStartedAt
      ).length
    : 0;
  console.log(`[terminfo-shots] wrote ${written} png(s) this run to ${OUTPUT_DIR}`);

  if (failures.length > 0) {
    throw new Error(`[terminfo-shots] ${failures.length} step(s) failed:\n${failures.join("\n")}`);
  }
  if (written === 0) {
    throw new Error(`[terminfo-shots] no PNGs written this run to ${OUTPUT_DIR}`);
  }
});
