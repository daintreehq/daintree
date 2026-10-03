// Agent-state transition latency for a pane the user cannot see: working →
// waiting must hold the full quiet window and waiting → working must wake at
// the same speed as a visible pane. The bounds are soft assertions, so every
// breach in a run is reported rather than the first one ending it. The
// correctness half (visible cycles, untimed hidden-pane transitions,
// hidden-stream integrity, blurred window, power saving, no false directing)
// runs in e2e/full/terminal/terminal-agent-state-latency.spec.ts.
//
//   RUN_PERF_AGENT_STATE_LATENCY=1 npx playwright test --config=playwright.perf.config.ts \
//     e2e/perf/agent-state-latency-perf.spec.ts

import { test, expect, type Locator, type Page } from "@playwright/test";
import { writeFileSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getTerminalText, waitForTerminalText, writeTerminalInput } from "../helpers/terminal";
import { switchWorktree } from "../helpers/workflows";
import { getGridPanelIds } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_SHORT } from "../helpers/timeouts";
import { dismissBlockingPalette } from "../helpers/overlays";
import {
  installFakeAgent,
  fakeAgentEnv,
  ptyWrite,
  sendFakeAgentCommand,
  FAKE_AGENT_STOP,
} from "../helpers/fakeAgent";

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

const perfDescribe =
  process.env.RUN_PERF_AGENT_STATE_LATENCY === "1" ? test.describe : test.describe.skip;

perfDescribe("Perf: hidden-pane agent-state transition latency", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({
      name: "agent-state-latency-perf",
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
      JSON.stringify({ name: "agent-state-latency-perf", private: true }, null, 2) + "\n"
    );
    execSync("git add -A && git commit -m latency-fixture", { cwd: dir, stdio: "ignore" });

    ctx = await launchApp({ env: fakeAgentEnv(fakeBinDir) });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Agent State Latency Perf");
    await launchAgent(ctx.window);
  });

  test.afterAll(async () => {
    if (ctx?.window && agentPanelId) {
      await ptyWrite(ctx.window, agentPanelId, `${FAKE_AGENT_STOP}\r`);
    }
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
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
});
