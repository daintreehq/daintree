import { test, expect, type Locator, type Page } from "@playwright/test";
import { writeFileSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  getTerminalText,
  getTerminalTextById,
  waitForTerminalText,
  waitForTerminalReady,
  writeTerminalInput,
  openTerminalContextMenu,
  clickTerminalContextMenuItem,
} from "../../helpers/terminal";
import { spawnTerminalAndVerify, switchWorktree } from "../../helpers/workflows";
import { getGridPanelIds } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_LONG, T_MEDIUM, T_SHORT } from "../../helpers/timeouts";
import { dismissBlockingPalette } from "../../helpers/overlays";
import {
  installFakeAgent,
  fakeAgentEnv,
  ptyWrite,
  readFakeAgentStdin,
  sendFakeAgentCommand,
  FAKE_AGENT_IDLE,
  FAKE_AGENT_STOP,
  FAKE_AGENT_MARK_OUTPUT,
} from "../../helpers/fakeAgent";

// The quiet window an agent terminal holds before working becomes waiting
// (`AGENT_WAITING_QUIET_MS`). Both ends are measured from the agent's own record
// of when it stopped, against the renderer's receipt of the state event, so the
// floor catches a premature waiting and the ceiling is what the user feels.
const QUIET_WINDOW_MS = 8_000;
const WAITING_FLOOR_MS = QUIET_WINDOW_MS - 500;
const WAITING_CEILING_MS = QUIET_WINDOW_MS + T_SHORT;
const WORKING_CEILING_MS = T_SHORT;
// Long enough in waiting for the idle poll backoff (3s settle) to engage, so a
// wake is measured from the slow cadence a real idle agent sits on.
const BACKOFF_SETTLE_MS = 6_000;
const STREAM_WARMUP_MS = 4_000;
// A stdin-driven idle echoes once and restarts the quiet clock, so it gets
// headroom above the quiet window that scales with the runner.
const T_WAITING = T_LONG * 2;
const FEATURE_BRANCH = "feature/test-branch";

let ctx: AppContext;
let fakeBinDir: string;
let fixtureCleanup: (() => void) | undefined;
let agentPanelId: string;
let agentPanel: Locator;

interface Observed {
  kind: "state" | "dom" | "power";
  value: string;
  at: number;
}

// Installed once, before any action under test, so nothing is sampled after
// the fact: host state events, the pane's rendered state, and power-policy pushes.
async function installObservers(page: Page, panelId: string): Promise<void> {
  await page.evaluate((id) => {
    type Entry = { kind: "state" | "dom" | "power"; value: string; at: number };
    const w = window as unknown as {
      __observed?: Entry[];
      electron?: {
        terminal?: {
          onAgentStateChanged?: (cb: (data: { terminalId: string; state: string }) => void) => void;
        };
        events?: { on?: (name: string, cb: (payload: { level?: string }) => void) => void };
      };
    };
    if (w.__observed) return;
    const log: Entry[] = [];
    w.__observed = log;
    w.electron?.terminal?.onAgentStateChanged?.((data) => {
      if (data.terminalId === id) log.push({ kind: "state", value: data.state, at: Date.now() });
    });
    w.electron?.events?.on?.("system:power-policy-changed", (payload) => {
      log.push({ kind: "power", value: payload.level ?? "unknown", at: Date.now() });
    });
    let lastDom: string | undefined;
    new MutationObserver(() => {
      const state =
        document.querySelector(`[data-panel-id="${id}"]`)?.getAttribute("data-agent-state") ??
        "null";
      if (state !== lastDom) {
        lastDom = state;
        log.push({ kind: "dom", value: state, at: Date.now() });
      }
    }).observe(document.body, {
      subtree: true,
      attributes: true,
      childList: true,
      attributeFilter: ["data-agent-state"],
    });
  }, panelId);
}

async function observed(page: Page, kind: Observed["kind"], since: number): Promise<Observed[]> {
  const all = await page.evaluate(
    () => (window as unknown as { __observed?: Observed[] }).__observed ?? []
  );
  return all.filter((e) => e.kind === kind && e.at >= since);
}

async function waitForObserved(
  page: Page,
  kind: Observed["kind"],
  value: string,
  since: number,
  timeout: number
): Promise<number> {
  let hit: Observed | undefined;
  await expect
    .poll(
      async () => {
        hit = (await observed(page, kind, since)).find((e) => e.value === value);
        return hit !== undefined;
      },
      { timeout, intervals: [100] }
    )
    .toBe(true);
  return hit!.at - since;
}

function report(name: string, ms: number): void {
  test.info().annotations.push({ type: "latency", description: `${name}=${ms}ms` });
}

/** Commands go to the latency agent's own control file; other agents in this file ignore them. */
function agentCommand(cmd: Parameters<typeof sendFakeAgentCommand>[1]) {
  return sendFakeAgentCommand(fakeBinDir, cmd, T_MEDIUM, agentPanelId);
}

/**
 * Puts the agent in `working` with its stream advancing. `settled` is for a
 * test that times the next working → waiting against the quiet-window floor:
 * the temperature model needs a run of advancing output before a stop reads
 * as a real one rather than a heartbeat over a static screen.
 */
async function establishWorking(page: Page, { settled = false } = {}): Promise<void> {
  const started = await agentCommand("work");
  // The launch-time state is hydrated, not announced, so until the first
  // transition the rendered pane is the only evidence there is.
  const latestState = async () =>
    (await observed(page, "state", 0)).at(-1)?.value ??
    (await agentPanel.getAttribute("data-agent-state"));
  await expect.poll(latestState, { timeout: T_LONG, intervals: [100] }).toBe("working");
  if (settled) {
    // timer: AgentActivityTemperature half-life (DEFAULT_HALF_LIFE_MS, 4.5s)
    await page.waitForTimeout(STREAM_WARMUP_MS);
  }
  // Agent-side truth that output is advancing, not a heartbeat alone.
  await expect
    .poll(async () => (await agentCommand("stream-on")).streamSeq, {
      timeout: T_MEDIUM,
      intervals: [100],
    })
    .toBeGreaterThan(started.streamSeq);
  expect(await latestState()).toBe("working");
}

async function measureTransition(
  page: Page,
  label: string,
  state: "waiting" | "working",
  since: number,
  mounted: boolean
): Promise<number> {
  const ms = await waitForObserved(page, "state", state, since, T_LONG * 3);
  report(`${label}.event`, ms);
  if (mounted) {
    const rendered = await waitForObserved(page, "dom", state, since, T_SHORT);
    report(`${label}.rendered`, rendered);
    expect.soft(rendered - ms).toBeLessThanOrEqual(T_SHORT / 3);
  }
  return ms;
}

async function measureWorkingToWaiting(page: Page, label: string, mounted = true): Promise<void> {
  const stopped = await agentCommand("idle");
  const ms = await measureTransition(
    page,
    `${label}.working→waiting`,
    "waiting",
    stopped.at,
    mounted
  );
  expect.soft(ms).toBeGreaterThanOrEqual(WAITING_FLOOR_MS);
  expect.soft(ms).toBeLessThanOrEqual(WAITING_CEILING_MS);
}

async function measureWaitingToWorking(page: Page, label: string, mounted = true): Promise<void> {
  // timer: FSM_IDLE_BACKOFF_SETTLE_MS (3s) — the wake must come from the
  // backed-off idle poll a real waiting agent sits on, which nothing renders.
  await page.waitForTimeout(BACKOFF_SETTLE_MS);
  const started = await agentCommand("work");
  const ms = await measureTransition(
    page,
    `${label}.waiting→working`,
    "working",
    started.at,
    mounted
  );
  expect.soft(ms).toBeLessThanOrEqual(WORKING_CEILING_MS);
}

/** How many of the pane's working spinners visibly turn within one reduced-rate step. */
async function spinnersAdvancing(page: Page): Promise<{ count: number; advancing: number }> {
  return page.evaluate(async (id) => {
    const spinners = Array.from(
      document.querySelector(`[data-panel-id="${id}"]`)?.querySelectorAll(".animate-spin-slow") ??
        []
    );
    const read = () => spinners.map((el) => getComputedStyle(el).transform);
    const before = read();
    const moved = before.map(() => false);
    // Polled, and done as soon as every spinner has stepped. Timers rather than
    // frames, because the test windows run in the background where rAF can stall.
    // timer: the cap spans several steps of the slowest tier that still moves:
    // `.animate-spin-slow` under `body[data-motion-rate="reduced"]` steps about
    // every 120ms (index.css).
    const deadline = performance.now() + 900;
    while (moved.includes(false) && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      read().forEach((transform, i) => {
        if (transform !== before[i]) moved[i] = true;
      });
    }
    return { count: spinners.length, advancing: moved.filter(Boolean).length };
  }, agentPanelId);
}

async function setWindowFocus(focused: boolean): Promise<void> {
  await ctx.app.evaluate(({ BrowserWindow }, focus) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (focus) win?.focus();
    else win?.blur();
  }, focused);
}

async function newestPanelId(page: Page, previousIds: Set<string>): Promise<string> {
  let id: string | undefined;
  await expect
    .poll(
      async () => {
        id = (await getGridPanelIds(page)).find((candidate) => !previousIds.has(candidate));
        return id !== undefined;
      },
      { timeout: T_LONG, intervals: [250] }
    )
    .toBe(true);
  return id!;
}

/**
 * Launch the fake Claude from the toolbar tray, answer its workspace-trust
 * prompt, and wait until the pane is a detected agent in `working`. The fake
 * binary emits OSC 9;4 progress so working is driven by a viewport-independent
 * signal rather than output volume, which is unreliable in small grid tiles.
 */
async function launchWorkingClaude(page: Page): Promise<{ panelId: string; panel: Locator }> {
  const before = new Set(await getGridPanelIds(page));
  await dismissBlockingPalette(page);
  await page.locator(SEL.agent.trayButton).click();
  await page.locator(SEL.agent.launcherRow("Claude")).first().click();

  const panelId = await newestPanelId(page, before);
  const panel = page.locator(`[data-panel-id="${panelId}"]`);

  await expect
    .poll(
      async () => {
        const lower = (await getTerminalText(panel)).toLowerCase();
        if (lower.includes("fake_claude_ready")) return "ready";
        if (lower.includes("enter to confirm")) return "trust-prompt";
        return "starting";
      },
      { timeout: T_LONG, intervals: [250] }
    )
    .not.toBe("starting");
  if (!(await getTerminalText(panel)).includes("FAKE_CLAUDE_READY")) {
    await writeTerminalInput(page, panel, "\r");
  }
  await waitForTerminalText(panel, "FAKE_CLAUDE_READY", T_LONG);
  await expect
    .poll(() => panel.getAttribute("data-detected-agent-id"), {
      timeout: 60_000,
      intervals: [250, 500],
    })
    .toBe("claude");
  await expect(panel).toHaveAttribute("data-agent-state", "working", { timeout: T_LONG });
  return { panelId, panel };
}

async function stopAgent(page: Page, panelId: string, panel: Locator): Promise<void> {
  expect(await ptyWrite(page, panelId, `${FAKE_AGENT_STOP}\r`)).toBe(true);
  await waitForTerminalText(panel, "FAKE_CLAUDE_EXIT", T_LONG);
}

/**
 * The main worktree's collapsed session summary in the sidebar. It counts the
 * renderer panel store's agent states, and stays on screen while the pane
 * itself is unmounted because another worktree is active.
 */
function mainSessionSummary(page: Page): Locator {
  return page
    .locator(SEL.worktree.mainRow)
    .locator('[data-testid="collapsed-session-indicators"]')
    .first();
}

async function expectSummaryState(summary: Locator, state: "waiting" | "working", timeout: number) {
  const other = state === "waiting" ? "working" : "waiting";
  await expect(summary.locator(`[data-state="${state}"]`)).toHaveCount(1, { timeout });
  await expect(summary.locator(`[data-state="${other}"]`)).toHaveCount(0);
  await expect(summary).toHaveAttribute("aria-label", new RegExp(`\\b1 ${state}\\b`));
}

// Tests share one long-lived agent, but each starts by putting it back in
// `working` and ends back on the main worktree, so a failure only relaunches
// the app for the remainder rather than stranding the tests after it.
test.describe("Full: agent-state transitions, status surfaces, and hidden-pane delivery", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({
      name: "terminal-agent-state-latency",
      withFeatureBranch: true,
    });
    fixtureCleanup = cleanup;
    // perPane keys each instance's control, events and stdin logs on its pane,
    // so the extra agents the status tests launch never replay the latency
    // agent's control commands.
    fakeBinDir = installFakeAgent(dir, {
      streamLinesPerSec: 80,
      queryOnFocus: true,
      perPane: true,
    });
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "terminal-agent-state-latency", private: true }, null, 2) + "\n"
    );
    execSync("git add -A && git commit -m latency-fixture", { cwd: dir, stdio: "ignore" });

    ctx = await launchApp({ env: fakeAgentEnv(fakeBinDir) });
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      dir,
      "Terminal Agent State Latency"
    );
    const launched = await launchWorkingClaude(ctx.window);
    agentPanelId = launched.panelId;
    agentPanel = launched.panel;
    await installObservers(ctx.window, agentPanelId);
  });

  test.afterAll(async () => {
    if (ctx?.window && agentPanelId) {
      await ptyWrite(ctx.window, agentPanelId, `${FAKE_AGENT_STOP}\r`);
    }
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("visible pane: both working cycles hold the quiet window and wake on output", async () => {
    test.setTimeout(180_000);
    const { window } = ctx;

    await establishWorking(window, { settled: true });
    await measureWorkingToWaiting(window, "visible.cycle1");
    await expect(agentPanel.locator(SEL.terminal.agentStateChip)).toHaveAttribute(
      "aria-label",
      "Agent state: waiting"
    );
    await measureWaitingToWorking(window, "visible.cycle1");
    await expect(agentPanel).toHaveAttribute("data-agent-state", "working", { timeout: T_SHORT });

    // A resumed agent must get the same window as a freshly launched one.
    // timer: AgentActivityTemperature half-life (DEFAULT_HALF_LIFE_MS, 4.5s)
    await window.waitForTimeout(STREAM_WARMUP_MS);
    await measureWorkingToWaiting(window, "visible.cycle2");
    await measureWaitingToWorking(window, "visible.cycle2");
  });

  // Untimed: the hidden-pane latency bounds are a benchmark
  // (e2e/perf/agent-state-latency-perf.spec.ts); delivery itself is not.
  test("hidden pane: state transitions reach the view while it is hidden", async () => {
    test.setTimeout(180_000);
    const { window } = ctx;
    const summary = mainSessionSummary(window);

    await establishWorking(window);
    await switchWorktree(window, FEATURE_BRANCH);
    await expect(agentPanel).toBeHidden({ timeout: T_LONG });
    await expectSummaryState(summary, "working", T_LONG);

    // The subject is what the renderer's panel store makes of the host events
    // while the pane is hidden, read off the surface that draws from it.
    await agentCommand("idle");
    await expectSummaryState(summary, "waiting", T_LONG * 3);
    await expect(agentPanel).toBeHidden();
    await agentCommand("work");
    await expectSummaryState(summary, "working", T_LONG * 3);
    await expect(agentPanel).toBeHidden();

    await switchWorktree(window, "main");
    await expect(agentPanel).toBeVisible({ timeout: T_LONG });
    await expect(agentPanel).toHaveAttribute("data-agent-state", "working", { timeout: T_SHORT });
  });

  test("hidden pane: a dense stream lands whole, and is on screen at reveal", async () => {
    test.setTimeout(180_000);
    const { window } = ctx;

    await establishWorking(window);
    await switchWorktree(window, FEATURE_BRANCH);
    await expect(agentPanel).toBeHidden({ timeout: T_LONG });
    // Everything from here to the marker is written while the pane is hidden.
    const hiddenFrom = await agentCommand("stream-on");
    await expect
      .poll(async () => (await agentCommand("stream-on")).streamSeq, {
        timeout: T_MEDIUM,
        intervals: [100],
      })
      .toBeGreaterThan(hiddenFrom.streamSeq + 60);
    await agentCommand("stream-off");
    const marked = await agentCommand("mark");
    expect(marked.streamSeq).toBeGreaterThan(hiddenFrom.streamSeq + 50);

    // Still hidden: the buffer must already hold the marker and every line of
    // the interval. A marker, or a whole tail, would not show a dropped batch.
    await expect
      .poll(() => getTerminalTextById(window, agentPanelId), {
        timeout: T_MEDIUM,
        intervals: [50, 100],
      })
      .toContain(FAKE_AGENT_MARK_OUTPUT);
    const buffer = await getTerminalTextById(window, agentPanelId);
    const landed = new Set(
      Array.from(buffer.matchAll(/\[fake-claude (\d{6})\]/g), (m) => Number(m[1]))
    );
    const missing: number[] = [];
    for (let seq = hiddenFrom.streamSeq + 1; seq <= marked.streamSeq; seq++) {
      if (!landed.has(seq)) missing.push(seq);
    }
    expect(missing).toEqual([]);

    const revealAt = Date.now();
    await switchWorktree(window, "main");
    await expect(agentPanel).toBeVisible({ timeout: T_LONG });
    // The marker is the last line written, so a viewport pinned to the bottom shows it.
    await expect
      .poll(() => agentPanel.locator(SEL.terminal.xtermRows).innerText(), {
        timeout: T_SHORT,
        intervals: [50, 100],
      })
      .toContain(FAKE_AGENT_MARK_OUTPUT);
    report("hidden.reveal→marker-on-screen", Date.now() - revealAt);
  });

  test("blurred window: transitions keep their speed and motion only slows", async () => {
    test.setTimeout(240_000);
    const { window } = ctx;
    const isFocused = () =>
      ctx.app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFocused() ?? false
      );

    await establishWorking(window, { settled: true });
    await setWindowFocus(true);
    const hadFocus = await expect
      .poll(isFocused, { timeout: T_SHORT, intervals: [100] })
      .toBe(true)
      .then(
        () => true,
        () => false
      );
    // Native focus is the OS's to give; without it a blur changes nothing.
    const noFocusReason = "the OS did not give the window native focus";
    test.info().annotations.push({ type: "conditional-skip", description: noFocusReason });
    test.skip(!hadFocus, noFocusReason);

    try {
      const blurAt = Date.now();
      await setWindowFocus(false);
      // On battery the policy is already `saving` and no event marks the blur.
      await expect
        .poll(() => window.evaluate(() => document.body.dataset.motionRate ?? "unset"), {
          timeout: T_SHORT,
        })
        .toBe("reduced");
      expect(await isFocused()).toBe(false);
      report("blurred.policy-events", (await observed(window, "power", blurAt)).length);

      // Visible beside other work is still glanced at: slower, never still.
      const glanced = await spinnersAdvancing(window);
      expect(glanced.count).toBeGreaterThan(0);
      expect(glanced.advancing).toBe(glanced.count);

      await measureWorkingToWaiting(window, "blurred");
      await measureWaitingToWorking(window, "blurred");
    } finally {
      await setWindowFocus(true);
    }

    await expect
      .poll(
        async () => {
          const motion = await spinnersAdvancing(window);
          return motion.count > 0 && motion.advancing === motion.count;
        },
        { timeout: T_MEDIUM, intervals: [250] }
      )
      .toBe(true);
  });

  // Battery and a locked screen cannot be arranged from a test, so this drives
  // the two body flags the motion hook owns and checks what the shipped
  // stylesheet does with them. It only needs a spinner, so no stream warm-up.
  test("power saving slows a visible working spinner and stops only an unseen one", async () => {
    const { window } = ctx;
    await agentCommand("work");
    await expect(agentPanel).toHaveAttribute("data-agent-state", "working", { timeout: T_LONG });

    const withFlags = (flags: { powerSaving?: string; motionRate?: string }) =>
      window.evaluate(
        async ([id, next]) => {
          const set = (key: "powerSaving" | "motionRate", value: string | undefined) => {
            if (value === undefined) delete document.body.dataset[key];
            else document.body.dataset[key] = value;
          };
          set("powerSaving", next.powerSaving);
          set("motionRate", next.motionRate);
          await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
          const spinner = document
            .querySelector(`[data-panel-id="${id}"]`)
            ?.querySelector(".animate-spin-slow");
          const style = spinner ? getComputedStyle(spinner) : null;
          return {
            name: style?.animationName ?? "missing",
            timing: style?.animationTimingFunction ?? "missing",
          };
        },
        [agentPanelId, flags] as const
      );
    const steps = (value: string) => Number(/steps\((\d+)/.exec(value)?.[1] ?? Number.NaN);

    const original = await window.evaluate(() => ({
      powerSaving: document.body.dataset.powerSaving,
      motionRate: document.body.dataset.motionRate,
    }));

    try {
      const full = await withFlags({});
      const reduced = await withFlags({ motionRate: "reduced" });
      expect(full.name).not.toBe("none");
      expect(reduced.name).toBe(full.name);
      expect(steps(reduced.timing)).toBeLessThanOrEqual(steps(full.timing) / 2);
      const motion = await spinnersAdvancing(window);
      expect(motion.count).toBeGreaterThan(0);
      expect(motion.advancing).toBe(motion.count);

      expect((await withFlags({ powerSaving: "true" })).name).toBe("none");
    } finally {
      await withFlags(original);
    }
  });

  // A TUI can re-query the terminal after pane selection and xterm answers
  // through onData, the path directing listens on (4fc44b85b2).
  test("terminal query replies after pane selection do not enter directing", async () => {
    const windowsSkipReason =
      "ConPTY does not reliably expose xterm-generated query replies in the child stdin";
    test.info().annotations.push({ type: "platform-skip", description: windowsSkipReason });
    test.skip(process.platform === "win32", windowsSkipReason);
    test.setTimeout(180_000);
    const { window } = ctx;

    // Directing is only reachable from waiting.
    await establishWorking(window);
    await agentCommand("idle");
    await expect(agentPanel).toHaveAttribute("data-agent-state", "waiting", {
      timeout: T_LONG * 3,
    });

    await switchWorktree(window, FEATURE_BRANCH);
    await expect(agentPanel).toBeHidden({ timeout: T_LONG });

    const stdinBefore = readFakeAgentStdin(fakeBinDir, agentPanelId).length;
    const selectAt = Date.now();
    await switchWorktree(window, "main");
    await expect(agentPanel).toBeVisible({ timeout: T_LONG });
    await agentPanel.locator(SEL.terminal.xtermRows).click();
    await agentCommand("query");

    // Every reply must have made the round trip, or the run exercised nothing.
    const replies = () => readFakeAgentStdin(fakeBinDir, agentPanelId).slice(stdinBefore);
    // eslint-disable-next-line no-control-regex
    const expected = [/\x1b\[\d+;\d+R/, /\x1b\[\?[\d;]+c/, /\x1b\]11;rgb:/];
    await expect
      .poll(() => expected.every((reply) => reply.test(replies())), {
        timeout: T_MEDIUM,
        intervals: [100],
      })
      .toBe(true);
    // Directing is entered synchronously from onData and held for seconds.
    // timer: negative-assertion dwell over DIRECTING_DEBOUNCE_SHORT_MS (1.5s), so
    // a wrongly entered directing has rendered before the log is read.
    await window.waitForTimeout(2_000);

    const rendered = (await observed(window, "dom", selectAt)).map((e) => e.value);
    expect(rendered).toContain("waiting");
    expect(rendered).not.toContain("directing");
    await expect(agentPanel).toHaveAttribute("data-agent-state", "waiting");

    // Positive control: the same observer does see directing when it is real.
    const typeAt = Date.now();
    await window.keyboard.type("x");
    await waitForObserved(window, "dom", "directing", typeAt, T_SHORT);
  });

  // The status tests launch their own short-lived agents beside the latency one
  // and drive them over stdin, the way a user's keystrokes would.
  test("agent session drives the working→waiting state arc, chip, and hybrid input bar", async () => {
    test.setTimeout(180_000);
    const { window } = ctx;

    const { panelId, panel } = await launchWorkingClaude(window);

    await test.step("working state surfaces the agent chip and an active hybrid input bar", async () => {
      // The agent-state chip is a role=status element labelled with the state.
      const chip = panel.locator(SEL.terminal.agentStateChip);
      await expect(chip).toBeVisible({ timeout: T_MEDIUM });
      await expect(chip).toHaveAttribute("aria-label", "Agent state: working");

      // The hybrid input bar renders for agent panels (CodeMirror editor) and is
      // not disabled while the backend is connected and the agent is working.
      const editor = panel.locator(SEL.terminal.cmEditor);
      await expect(editor).toBeVisible({ timeout: T_MEDIUM });
      const picker = panel.locator('[aria-label="Open command picker"]');
      await expect(picker).toBeVisible({ timeout: T_MEDIUM });
      await expect(picker).toBeEnabled();
    });

    await test.step("agent transitions to waiting once the OSC heartbeat stops", async () => {
      expect(await ptyWrite(window, panelId, `${FAKE_AGENT_IDLE}\r`)).toBe(true);
      await expect
        .poll(() => panel.getAttribute("data-agent-state"), {
          timeout: T_WAITING,
          intervals: [500, 1000],
        })
        .toBe("waiting");
      // The visible chip must track the FSM, not lag on the prior label.
      await expect(panel.locator(SEL.terminal.agentStateChip)).toHaveAttribute(
        "aria-label",
        "Agent state: waiting"
      );
    });

    await test.step("agent state clears when the session exits", async () => {
      await stopAgent(window, panelId, panel);
      await expect
        .poll(() => panel.getAttribute("data-agent-state"), {
          timeout: T_LONG,
          intervals: [250, 500],
        })
        .toBeNull();
    });
  });

  test("exit-error restart banner exposes a working Restart action", async () => {
    test.setTimeout(120_000);
    const { window } = ctx;

    const panel = await spawnTerminalAndVerify(window);
    const panelId = await panel.evaluate((el) => {
      const p = el.closest("[data-panel-id]");
      return p?.getAttribute("data-panel-id") ?? "";
    });

    // A non-zero exit always preserves the terminal for debugging, surfacing the
    // exit-error restart banner with a single recovery action.
    expect(await ptyWrite(window, panelId, "exit 1\r")).toBe(true);

    const banner = panel.getByRole("alert");
    await expect(banner).toContainText("Session exited with code 1", { timeout: T_LONG });

    const restartAction = panel.locator(SEL.terminal.restartBannerAction);
    await expect(restartAction).toBeVisible({ timeout: T_MEDIUM });
    await expect(restartAction).toBeEnabled();

    // Clicking Restart respawns the PTY and clears the exit-error banner.
    await restartAction.click();
    await expect(banner).not.toBeVisible({ timeout: T_LONG });
    // The recovery action is only meaningful if the PTY is actually live again,
    // not merely if the banner was dismissed.
    await waitForTerminalReady(window, panel, T_LONG);
  });

  test("context menu gates destructive actions while an agent is working", async () => {
    test.setTimeout(180_000);
    const { window } = ctx;

    const { panelId, panel } = await launchWorkingClaude(window);

    await openTerminalContextMenu(panel);

    // Opening the menu involves clicks that can momentarily repaint the pane
    // (#8867); re-confirm the working state before asserting the gated items.
    await expect
      .poll(() => panel.getAttribute("data-agent-state"), {
        timeout: T_MEDIUM,
        intervals: [250],
      })
      .toBe("working");

    await test.step("Restart terminal opens a confirmation dialog instead of firing", async () => {
      await clickTerminalContextMenuItem(panel, "Restart terminal");
      const dialog = window.getByRole("alertdialog");
      await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
      await expect(dialog).toContainText("Its agent is working and will be interrupted.");
      // Cancel — leave the agent session intact.
      await window.locator('[data-confirm-role="cancel"]').click();
      await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });
    });

    await test.step("Kill terminal is guarded by the same confirmation while working", async () => {
      await openTerminalContextMenu(panel);
      await clickTerminalContextMenuItem(panel, "Kill terminal");
      const dialog = window.getByRole("alertdialog");
      await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
      await expect(dialog).toContainText("Its agent is working and will be stopped.");
      await window.locator('[data-confirm-role="cancel"]').click();
      await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });
    });

    await test.step("Escape closes the context menu", async () => {
      await openTerminalContextMenu(panel);
      const menu = window.locator(SEL.contextMenu.content);
      await expect(menu).toBeVisible({ timeout: T_SHORT });
      await window.keyboard.press("Escape");
      await expect(menu).not.toBeVisible({ timeout: T_MEDIUM });
    });

    // Clean up the agent session so it doesn't bleed into afterAll teardown.
    await stopAgent(window, panelId, panel);
  });
});
