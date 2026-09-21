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
  writeTerminalInput,
} from "../../helpers/terminal";
import { switchWorktree } from "../../helpers/workflows";
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

async function establishWorking(page: Page): Promise<void> {
  const started = await sendFakeAgentCommand(fakeBinDir, "work");
  // The launch-time state is hydrated, not announced, so until the first
  // transition the rendered pane is the only evidence there is.
  const latestState = async () =>
    (await observed(page, "state", 0)).at(-1)?.value ??
    (await agentPanel.getAttribute("data-agent-state"));
  await expect.poll(latestState, { timeout: T_LONG, intervals: [100] }).toBe("working");
  // A heartbeat over a static screen is demoted early by the temperature model;
  // a settled working agent is one whose visible output is still advancing.
  await page.waitForTimeout(STREAM_WARMUP_MS);
  const later = await sendFakeAgentCommand(fakeBinDir, "stream-on");
  expect(later.streamSeq).toBeGreaterThan(started.streamSeq);
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
  const stopped = await sendFakeAgentCommand(fakeBinDir, "idle");
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
  await page.waitForTimeout(BACKOFF_SETTLE_MS);
  const started = await sendFakeAgentCommand(fakeBinDir, "work");
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
    await new Promise((resolve) => setTimeout(resolve, 900));
    const after = read();
    return {
      count: spinners.length,
      advancing: after.filter((transform, i) => transform !== before[i]).length,
    };
  }, agentPanelId);
}

async function setWindowFocus(focused: boolean): Promise<void> {
  await ctx.app.evaluate(({ BrowserWindow }, focus) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (focus) win?.focus();
    else win?.blur();
  }, focused);
}

async function launchAgent(page: Page): Promise<void> {
  const before = new Set(await getGridPanelIds(page));
  await dismissBlockingPalette(page);
  await page.locator(SEL.agent.trayButton).click();
  await page.locator(SEL.agent.launcherRow("Claude")).first().click();

  await expect
    .poll(async () => (await getGridPanelIds(page)).some((id) => !before.has(id)), {
      timeout: T_LONG,
      intervals: [250],
    })
    .toBe(true);
  agentPanelId = (await getGridPanelIds(page)).find((id) => !before.has(id))!;
  agentPanel = page.locator(`[data-panel-id="${agentPanelId}"]`);
  await installObservers(page, agentPanelId);

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const lower = (await getTerminalText(agentPanel)).toLowerCase();
    if (lower.includes("fake_claude_ready")) break;
    if (lower.includes("enter to confirm")) {
      await writeTerminalInput(page, agentPanel, "\r");
      break;
    }
    await page.waitForTimeout(250);
  }
  await waitForTerminalText(agentPanel, "FAKE_CLAUDE_READY", T_LONG);
  await expect
    .poll(() => agentPanel.getAttribute("data-detected-agent-id"), {
      timeout: 60_000,
      intervals: [250, 500],
    })
    .toBe("claude");
  await expect(agentPanel).toHaveAttribute("data-agent-state", "working", { timeout: T_LONG });
}

test.describe("Full: agent-state transition latency and hidden-pane delivery", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({
      name: "terminal-agent-state-latency",
      withFeatureBranch: true,
    });
    fixtureCleanup = cleanup;
    fakeBinDir = installFakeAgent(dir, {
      streamLinesPerSec: 80,
      controlChannel: true,
      queryOnFocus: true,
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
    await launchAgent(ctx.window);
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

    await establishWorking(window);
    await measureWorkingToWaiting(window, "visible.cycle1");
    await expect(agentPanel.locator(SEL.terminal.agentStateChip)).toHaveAttribute(
      "aria-label",
      "Agent state: waiting"
    );
    await measureWaitingToWorking(window, "visible.cycle1");
    await expect(agentPanel).toHaveAttribute("data-agent-state", "working", { timeout: T_SHORT });

    // A resumed agent must get the same window as a freshly launched one.
    await window.waitForTimeout(STREAM_WARMUP_MS);
    await measureWorkingToWaiting(window, "visible.cycle2");
    await measureWaitingToWorking(window, "visible.cycle2");
  });

  test("hidden pane: transitions reach the view at the same speed", async () => {
    test.setTimeout(180_000);
    const { window } = ctx;

    await establishWorking(window);
    await switchWorktree(window, FEATURE_BRANCH);
    await expect(agentPanel).toBeHidden({ timeout: T_LONG });
    await window.waitForTimeout(STREAM_WARMUP_MS);

    await measureWorkingToWaiting(window, "hidden", false);
    await measureWaitingToWorking(window, "hidden", false);

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
    const hiddenFrom = await sendFakeAgentCommand(fakeBinDir, "stream-on");
    await window.waitForTimeout(2_000);
    await sendFakeAgentCommand(fakeBinDir, "stream-off");
    const marked = await sendFakeAgentCommand(fakeBinDir, "mark");
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

    await establishWorking(window);
    await setWindowFocus(true);
    await window.waitForTimeout(1_000);
    const hadFocus = await isFocused();
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
  // stylesheet does with them.
  test("power saving slows a visible working spinner and stops only an unseen one", async () => {
    const { window } = ctx;
    await establishWorking(window);

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
    await sendFakeAgentCommand(fakeBinDir, "idle");
    await expect(agentPanel).toHaveAttribute("data-agent-state", "waiting", {
      timeout: T_LONG * 3,
    });

    await switchWorktree(window, FEATURE_BRANCH);
    await expect(agentPanel).toBeHidden({ timeout: T_LONG });

    const stdinBefore = readFakeAgentStdin(fakeBinDir).length;
    const selectAt = Date.now();
    await switchWorktree(window, "main");
    await expect(agentPanel).toBeVisible({ timeout: T_LONG });
    await agentPanel.locator(SEL.terminal.xtermRows).click();
    await sendFakeAgentCommand(fakeBinDir, "query");

    // Every reply must have made the round trip, or the run exercised nothing.
    const replies = () => readFakeAgentStdin(fakeBinDir).slice(stdinBefore);
    // eslint-disable-next-line no-control-regex
    const expected = [/\x1b\[\d+;\d+R/, /\x1b\[\?[\d;]+c/, /\x1b\]11;rgb:/];
    await expect
      .poll(() => expected.every((reply) => reply.test(replies())), {
        timeout: T_MEDIUM,
        intervals: [100],
      })
      .toBe(true);
    // Directing is entered synchronously from onData and held for seconds.
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
});
