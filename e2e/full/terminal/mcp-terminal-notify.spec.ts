/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-RPC payloads and window globals are untyped */
import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { addAndSwitchToProject } from "../../helpers/workflows";
import { getTerminalTextById } from "../../helpers/terminal";
import {
  fakeAgentEnv,
  installFakeAgent,
  listFakeAgentLaunches,
  ptyWrite,
  readFakeAgentStdin,
  sendFakeAgentCommand,
  type FakeAgentLaunch,
} from "../../helpers/fakeAgent";
import { T_LONG, T_MEDIUM } from "../../helpers/timeouts";

/**
 * Terminal notices end to end, received by the real Daintree Assistant in the
 * sidebar: an assistant lane asks, over its own MCP bearer, to be told when an
 * agent it prompted stops working, and Daintree types one line into that
 * lane's prompt — not into a second lane, and not into the worker.
 *
 * Every terminal runs the fake `claude` in per-pane mode, so each one's stdin
 * is logged to its own file: what reached a lane's prompt is read off disk,
 * not off a screen that could belong to whichever project is showing. The
 * worker's state is driven through its control file, never by typing into it,
 * so the only input a pane receives is what Daintree chose to send.
 */

const PROTOCOL_VERSION = "2025-06-18";
/**
 * One notice's worth of time: the 8s idle debounce before the worker reads as
 * waiting, the notice's 2s settle, the 2s coalesce, and the asking pane's own
 * settle grace — with the same CI scaling as every other timeout.
 */
const T_NOTICE = T_LONG * 4;

interface Endpoint {
  port: number;
  authorization: string;
}

interface Session {
  endpoint: Endpoint;
  sessionId: string;
}

function parseBody(contentType: string, raw: string): any {
  if (!raw) return null;
  if (contentType.includes("text/event-stream")) {
    const payloads = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    return payloads.length === 0 ? null : JSON.parse(payloads[payloads.length - 1]);
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function post(
  endpoint: Endpoint,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ sessionId: string | null; body: any }> {
  const res = await fetch(`http://127.0.0.1:${endpoint.port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: endpoint.authorization,
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(T_LONG * 2),
  });
  return {
    sessionId: res.headers.get("mcp-session-id"),
    body: parseBody(res.headers.get("content-type") ?? "", await res.text()),
  };
}

async function openSession(endpoint: Endpoint, clientName: string): Promise<Session> {
  const init = await post(endpoint, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version: "1.0.0" },
    },
  });
  if (!init.sessionId) {
    throw new Error(`initialize returned no session id: ${JSON.stringify(init.body)}`);
  }
  await post(
    endpoint,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { "mcp-session-id": init.sessionId, "mcp-protocol-version": PROTOCOL_VERSION }
  );
  return { endpoint, sessionId: init.sessionId };
}

let nextRequestId = 100;

async function rpc(session: Session, method: string, params: unknown): Promise<any> {
  const res = await post(
    session.endpoint,
    { jsonrpc: "2.0", id: nextRequestId++, method, params },
    { "mcp-session-id": session.sessionId, "mcp-protocol-version": PROTOCOL_VERSION }
  );
  return res.body;
}

/** A tool call's result, failing the test with the whole reply on a tool error. */
async function callOk(session: Session, name: string, args: Record<string, unknown>) {
  const body = await rpc(session, "tools/call", { name, arguments: args });
  expect(body?.result?.isError, `${name} failed: ${JSON.stringify(body)}`).not.toBe(true);
  return body.result.structuredContent;
}

async function dispatch(page: Page, actionId: string, args: unknown): Promise<any> {
  return page.evaluate(
    async ([id, payload]) => {
      const run = (window as any).__daintreeDispatchAction;
      if (typeof run !== "function") throw new Error("Action dispatch hook not available");
      return run(id, payload, { source: "test" });
    },
    [actionId, args] as const
  );
}

async function agentState(page: Page, panelId: string): Promise<string | null> {
  return page
    .locator(`[data-panel-id="${panelId}"]`)
    .getAttribute("data-agent-state")
    .catch(() => null);
}

async function waitForAgentState(page: Page, panelId: string, state: string): Promise<void> {
  await expect
    .poll(() => agentState(page, panelId), { timeout: T_NOTICE, intervals: [250, 500, 1000] })
    .toBe(state);
}

/** Answer the fake CLI's trust dialog, the one keystroke a test ever types. */
async function trust(page: Page, panelId: string): Promise<void> {
  await expect
    .poll(() => getTerminalTextById(page, panelId), { timeout: T_LONG, intervals: [200, 500] })
    .toContain("Enter to confirm");
  expect(await ptyWrite(page, panelId, "\r")).toBe(true);
  await expect
    .poll(() => getTerminalTextById(page, panelId), { timeout: T_LONG, intervals: [200, 500] })
    .toContain("FAKE_CLAUDE_READY");
}

/**
 * Every `Daintree:` line a pane has had submitted to its prompt. The fake CLI
 * reads a cooked tty, so input reaches it a line at a time, on Enter; a
 * trailing fragment with no newline behind it was typed but not submitted,
 * and does not count.
 */
function noticesFor(binDir: string, paneId: string): string[] {
  const lines = readFakeAgentStdin(binDir, paneId).split(/\r\n|\r|\n/);
  lines.pop();
  return lines
    .map((line) => line.replaceAll("\u001b[200~", "").replaceAll("\u001b[201~", "").trim())
    .filter((line) => line.startsWith("Daintree:"));
}

let ctx: AppContext;
let page: Page;
let binDir: string;
let repoB: string;
let cleanups: Array<() => void> = [];
let port: number;
let assistantId: string;
let otherLaneId: string;
let assistant: Session;
let workerId: string;

/** The fake CLI Daintree starts next, once it has recorded where it runs. */
async function nextLaunch(start: () => Promise<void>): Promise<FakeAgentLaunch> {
  const before = new Set(listFakeAgentLaunches(binDir).map((launch) => launch.paneId));
  await start();
  let found: FakeAgentLaunch | undefined;
  await expect
    .poll(
      () => {
        found = listFakeAgentLaunches(binDir).find((launch) => !before.has(launch.paneId));
        return found !== undefined;
      },
      { timeout: T_LONG * 2, intervals: [250, 500] }
    )
    .toBe(true);
  return found!;
}

/** Open an assistant lane in the sidebar and settle it at its prompt. */
async function startAssistantLane(click: () => Promise<void>): Promise<FakeAgentLaunch> {
  const launch = await nextLaunch(click);
  expect(launch.mcpToken, "the assistant lane was launched without a Daintree bearer").toBeTruthy();
  await trust(page, launch.paneId);
  await sendFakeAgentCommand(binDir, "idle", T_MEDIUM, launch.paneId);
  return launch;
}

test.describe.serial("MCP: terminal notices reach the pane that asked", () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const a = createFixtureRepo({ name: "notify-assistant" });
    const b = createFixtureRepo({ name: "notify-elsewhere" });
    cleanups = [a.cleanup, b.cleanup];
    repoB = b.dir;
    binDir = installFakeAgent(a.dir, { perPane: true });

    ctx = await launchApp({ env: fakeAgentEnv(binDir) });
    page = await openAndOnboardProject(ctx.app, ctx.window, a.dir, "notify-assistant");
    ctx.window = page;

    await page.evaluate(() => (window as any).electron.mcpServer.setEnabled(true));
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => (window as any).electron.mcpServer.getStatus())).port,
        {
          timeout: T_LONG,
          intervals: [200, 400, 800],
        }
      )
      .toBeTruthy();
    port = (await page.evaluate(() => (window as any).electron.mcpServer.getStatus())).port;

    // The assistant runs whichever agent the user picked; this machine may have
    // several installed, so pick Claude the way the settings tab stores it.
    await page.evaluate(() => {
      const key = "help-panel-storage";
      let blob: { state?: Record<string, unknown>; version?: number };
      try {
        blob = JSON.parse(window.localStorage.getItem(key) ?? "{}");
      } catch {
        blob = {};
      }
      blob.state = { ...(blob.state ?? {}), preferredAgentId: "claude" };
      blob.version = blob.version ?? 6;
      window.localStorage.setItem(key, JSON.stringify(blob));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator('[aria-label="Toggle Sidebar"]')).toBeVisible({ timeout: T_LONG });

    // The Daintree Assistant, opened in the sidebar and started the way a user
    // starts it, then a second lane beside it.
    await dispatch(page, "help.togglePanel", undefined);
    const first = await startAssistantLane(() =>
      page.locator('[data-testid="help-start-assistant"]').click()
    );
    const second = await startAssistantLane(() =>
      page.locator('[aria-label="New session"]').click()
    );
    assistantId = first.paneId;
    otherLaneId = second.paneId;
    expect(otherLaneId).not.toBe(assistantId);

    assistant = await openSession(
      { port, authorization: `Bearer ${first.mcpToken}` },
      "daintree-assistant-lane"
    );
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    for (const cleanup of cleanups) cleanup();
  });

  test("a launch with notify types one line into the assistant lane that asked, and nowhere else", async () => {
    test.setTimeout(180_000);
    const launched = await callOk(assistant, "agent.launch", {
      agentId: "claude",
      prompt: "Plan the refactor",
      name: "Worker",
      notify: true,
    });
    workerId = launched.terminalId;
    expect(workerId).toBeTruthy();
    // The worker is a real launch that carried its prompt, not a bare pane.
    await expect
      .poll(
        () =>
          listFakeAgentLaunches(binDir)
            .find((launch) => launch.paneId === workerId)
            ?.argv.join(" ") ?? "",
        { timeout: T_LONG }
      )
      .toContain("Plan the refactor");

    await trust(page, workerId);
    await waitForAgentState(page, workerId, "working");
    expect(noticesFor(binDir, assistantId)).toEqual([]);

    await sendFakeAgentCommand(binDir, "idle", T_MEDIUM, workerId);
    await expect
      .poll(() => noticesFor(binDir, assistantId), { timeout: T_NOTICE, intervals: [500, 1000] })
      .toEqual([
        `Daintree: terminal ${workerId} stopped working, now waiting at its prompt. Check it with terminal.getStatus.`,
      ]);
    expect(noticesFor(binDir, otherLaneId)).toEqual([]);
    expect(noticesFor(binDir, workerId)).toEqual([]);
  });

  test("notifyWhenIdle arms on a working agent and echoes the caller's note", async () => {
    test.setTimeout(180_000);
    await sendFakeAgentCommand(binDir, "work", T_MEDIUM, workerId);
    await waitForAgentState(page, workerId, "working");

    const armed = await callOk(assistant, "terminal.notifyWhenIdle", {
      terminalId: workerId,
      note: "run the reviewer next",
    });
    expect(armed).toEqual({ armed: true, terminalId: workerId });

    await sendFakeAgentCommand(binDir, "idle", T_MEDIUM, workerId);
    await expect
      .poll(() => noticesFor(binDir, assistantId).length, {
        timeout: T_NOTICE,
        intervals: [500, 1000],
      })
      .toBe(2);
    expect(noticesFor(binDir, assistantId)[1]).toBe(
      `Daintree: terminal ${workerId} stopped working, now waiting at its prompt. Your note: "run the reviewer next". Check it with terminal.getStatus.`
    );

    // A terminal that is not working answers at once and arms nothing.
    await waitForAgentState(page, workerId, "waiting");
    const idle = await callOk(assistant, "terminal.notifyWhenIdle", { terminalId: workerId });
    expect(idle).toMatchObject({ armed: false, terminalId: workerId, state: "waiting" });
  });

  test("a notice armed in one project arrives while another project is on screen", async () => {
    test.setTimeout(240_000);
    await callOk(assistant, "terminal.sendCommand", {
      terminalId: workerId,
      command: "Carry on with step two",
      notify: true,
    });
    await expect
      .poll(() => readFakeAgentStdin(binDir, workerId), { timeout: T_LONG })
      .toContain("Carry on with step two");
    await sendFakeAgentCommand(binDir, "work", T_MEDIUM, workerId);
    await waitForAgentState(page, workerId, "working");

    // The user moves to another project, so nothing in project A is on screen.
    // The helper returns once the window shows project B.
    const other = await addAndSwitchToProject(ctx.app, page, repoB, "notify-elsewhere");
    ctx.window = other;

    await sendFakeAgentCommand(binDir, "idle", T_MEDIUM, workerId);
    await expect
      .poll(() => noticesFor(binDir, assistantId).length, {
        timeout: T_NOTICE,
        intervals: [500, 1000],
      })
      .toBe(3);
    expect(noticesFor(binDir, assistantId)[2]).toBe(
      `Daintree: terminal ${workerId} stopped working, now waiting at its prompt. Check it with terminal.getStatus.`
    );

    // A terminal in the project now on screen is not one the assistant may
    // ask about: it gets the same answer as an id that does not exist.
    const elsewhere = await nextLaunch(async () => {
      const launched = await other.evaluate(async () => {
        const run = (window as any).__daintreeDispatchAction;
        return run("agent.launch", { agentId: "claude", name: "Elsewhere" }, { source: "test" });
      });
      expect(launched?.ok, JSON.stringify(launched)).toBe(true);
    });
    // Running, so a refusal is about its project and not about a spawn in flight.
    for (const terminalId of [elsewhere.paneId, "no-such-terminal"]) {
      const refused = await rpc(assistant, "tools/call", {
        name: "terminal.notifyWhenIdle",
        arguments: { terminalId },
      });
      expect(refused?.result?.isError).toBe(true);
      expect(JSON.stringify(refused)).toContain("NOTIFY_TARGET_UNAVAILABLE");
    }
    expect(noticesFor(binDir, otherLaneId)).toEqual([]);
  });

  test("an api-key client is neither shown notify nor allowed it", async () => {
    const status = await ctx.window.evaluate(() => (window as any).electron.mcpServer.getStatus());
    const external = await openSession(
      { port, authorization: `Bearer ${status.apiKey}` },
      "api-key-client"
    );

    const listed = await rpc(external, "tools/list", {});
    const launch = (listed?.result?.tools ?? []).find((tool: any) => tool.name === "agent.launch");
    expect(launch, "agent.launch is on the external surface").toBeTruthy();
    expect(Object.keys(launch.inputSchema.properties)).not.toContain("notify");

    const refused = await rpc(external, "tools/call", {
      name: "agent.launch",
      arguments: { agentId: "claude", prompt: "Plan it", notify: true },
    });
    expect(refused?.result?.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain("NOTIFY_NOT_ELIGIBLE");
  });
});
